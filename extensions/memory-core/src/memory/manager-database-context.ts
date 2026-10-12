// Owns the published index state and the isolated lifetime of shadow reindex work.
import type { DatabaseSync } from "node:sqlite";
import {
  createSubsystemLogger,
  resolveStateDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_FTS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  captureOpenClawAgentDatabaseExecution,
  openSqliteWorkerStore,
  openNodeSqliteDatabase,
  openOpenClawAgentSqliteWorkerStoreV2,
  runSqliteWorkerStoreWrite,
  type OpenClawAgentSqliteWorkerStore,
  type OpenClawAgentDatabaseExecution,
  type SqliteWorkerStore,
  runQueuedStoreWrite,
  readOpenClawAgentDatabaseIdentity,
  readSqliteDatabaseWriteTokenForPath,
  supportsOpenClawAgentDatabaseExecution,
  type StoreWriterQueue,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { runMemoryDatabaseFacts, runMemorySourceState } from "./manager-cpu-worker-runtime.js";
import { memoryDatabaseTableExists } from "./manager-db-kernel.js";
import { closeMemoryDatabase, openMemoryDatabaseReadOnlyAtPath } from "./manager-db.js";
import { withMemoryIndexGeneration } from "./manager-index-generation-lease.js";
import type {
  MemoryEmbeddingCacheMutation,
  MemoryPublicationOperations,
  MemoryPublicationResult,
  MemoryPublicationState,
} from "./manager-publication-task.js";
import { memoryEmbeddingCacheFitsInline } from "./manager-publication-transfer.js";
import {
  initializePublishedMemory,
  publishMemoryEmbeddingCache,
  publishMemorySource,
  retryMemoryPublication,
} from "./manager-publication.js";
import type { MemoryDatabaseFacts } from "./manager-retrieval-read.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  type MemoryShadowConnection,
} from "./manager-shadow-task.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";
import type { loadMemorySourceFileState } from "./manager-source-state.js";

type PublicationScope = Pick<SqliteWorkerStore<MemoryPublicationOperations>, "execute">;
const log = createSubsystemLogger("memory");
type PublicationWorker = {
  store: Pick<
    OpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>,
    "execute" | "run" | "close"
  >;
  busyTimeoutMs: number;
};

export class MemoryIndexDatabase {
  private readonly privateQueues = new Map<string, StoreWriterQueue>();
  private nativeWriterActive = false;
  private publicationWorker?: Promise<PublicationWorker>;
  private schemaAdmission?: Promise<void>;
  private factsToken?: string;
  private shadow?: {
    path: string;
    identity: MemoryShadowConnection["fileIdentity"];
    pragmas: MemoryShadowConnection["pragmas"];
  };
  private shadowClose?: Promise<void>;
  shadowReleased = false;

  static async openPublished(params: {
    agentId: string;
    writeOptions: Parameters<typeof openOpenClawAgentSqliteWorkerStoreV2>[0] & { path: string };
    readOnly: boolean;
    allowExtension: boolean;
    maintenanceSource?: MemoryIndexDatabase;
    schema: MemoryPublicationOperations["schema.admit"]["input"];
  }): Promise<MemoryIndexDatabase> {
    let admitted: Awaited<ReturnType<typeof initializePublishedMemory>> | undefined;
    params.maintenanceSource?.assertPublishedFileCurrent();
    if (!params.readOnly) {
      admitted = await initializePublishedMemory(
        params.writeOptions,
        params.maintenanceSource ? undefined : params.schema,
        () => {
          const source = params.maintenanceSource;
          if (source && (source.closed || !source.db.isOpen)) {
            throw new Error("Memory maintenance source connection changed");
          }
        },
      );
    }
    params.maintenanceSource?.assertPublishedFileCurrent();
    // Remaining synchronous manager reads use a query-only handle. Every
    // schema or index mutation belongs to the retained publication worker.
    const connection = openMemoryDatabaseReadOnlyAtPath(
      params.writeOptions.path,
      params.allowExtension,
      params.agentId,
    );
    const database = new MemoryIndexDatabase(
      connection.db,
      connection.release,
      params.readOnly,
      params.writeOptions,
      connection.hasIndex,
    );
    try {
      database.fts.enabled = params.schema.ftsEnabled;
      if (params.maintenanceSource) {
        database.installFacts(params.maintenanceSource.facts);
      }
      if (
        params.maintenanceSource &&
        (!database.fts.enabled || params.maintenanceSource.fts.available)
      ) {
        Object.assign(database.fts, params.maintenanceSource.fts);
      } else if (params.readOnly) {
        database.fts.available =
          database.hasIndex &&
          database.fts.enabled &&
          memoryDatabaseTableExists(database.db, "main", MEMORY_INDEX_FTS_TABLE);
        if (database.hasIndex) {
          database.installFacts(
            await runMemoryDatabaseFacts(params.writeOptions.path, params.agentId),
          );
        }
      } else if (admitted) {
        if (admitted.facts) {
          database.installFacts(admitted.facts, admitted.writeToken);
        }
        database.fts.available = admitted.value.ftsAvailable;
        database.fts.loadError = admitted.value.ftsError;
        if (params.schema.ftsEnabled && admitted.value.ftsError) {
          log.warn(`fts unavailable: ${admitted.value.ftsError}`);
        }
      }
      return database;
    } catch (error) {
      // Failed worker cleanup retains its own borrow with the agent lifecycle.
      database.release();
      throw error;
    }
  }

  static async openShadow(filename: string, allowExtension: boolean): Promise<MemoryIndexDatabase> {
    const store = await openSqliteWorkerStore<MemoryPublicationOperations>({
      moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
      databasePath: filename,
      input: { allowExtension },
    });
    let db: DatabaseSync | undefined;
    try {
      const connection = await store.execute({ type: "connection.inspect", input: undefined });
      assertMemoryShadowIdentity(filename, connection.fileIdentity);
      db = openNodeSqliteDatabase(filename, { readOnly: true, allowExtension });
      const database = new MemoryIndexDatabase(db);
      database.shadow = {
        path: filename,
        identity: connection.fileIdentity,
        pragmas: connection.pragmas,
      };
      database.publicationWorker = Promise.resolve(
        database.bindShadowWorker(store, connection.pragmas.busy_timeout),
      );
      return database;
    } catch (error) {
      try {
        await store.close();
      } finally {
        db?.close();
      }
      throw error;
    }
  }

  static captureWriteOptions(agentId: string, databasePath: string, source?: MemoryIndexDatabase) {
    const env = { ...(source?.writeOptions?.env ?? process.env) };
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    return {
      agentId,
      path: source?.writeOptions?.path ?? resolveUserPath(databasePath),
      env,
    };
  }

  readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  } = { enabled: false, available: null };
  readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  vectorReady: Promise<boolean> | null = null;
  ensuredVectorDimensions: number | undefined;
  facts: MemoryDatabaseFacts = {
    meta: null,
    serialized: null,
    revision: 0,
    hasIndexedChunks: false,
    hasSemanticChunks: false,
  };
  vectorDegradedWriteWarningShown = false;
  closed = false;

  constructor(
    readonly db: DatabaseSync,
    readonly release: () => void = () => closeMemoryDatabase(db),
    readonly readOnly = false,
    readonly writeOptions?: Parameters<typeof openOpenClawAgentSqliteWorkerStoreV2>[0],
    readonly hasIndex = true,
  ) {}

  private writeToken(): string | undefined {
    const filename = this.shadow?.path ?? this.writeOptions?.path;
    return filename ? readSqliteDatabaseWriteTokenForPath(filename) : undefined;
  }

  private installFacts(facts: MemoryDatabaseFacts, token?: string): void {
    this.facts = facts;
    this.factsToken = token;
  }

  async refreshFacts(): Promise<void> {
    if (!this.hasIndex || this.readOnly) {
      return;
    }
    const token = this.writeToken();
    if (token !== undefined && token === this.factsToken) {
      return;
    }
    this.installFacts(
      await this.executePublication({ type: "index.facts", input: undefined }, () => {
        if (this.closed || !this.db.isOpen) {
          throw new Error("Memory database owner closed before reading index facts");
        }
      }),
      token,
    );
  }

  async writeMetadata(meta: NonNullable<MemoryDatabaseFacts["meta"]>): Promise<void> {
    if (this.facts.serialized === JSON.stringify(meta)) {
      return;
    }
    await this.retryPublication(() =>
      this.executePublication({ type: "index.writeMetadata", input: meta }, () => {
        if (this.closed || !this.db.isOpen) {
          throw new Error("Memory database owner closed before writing index metadata");
        }
      }),
    );
  }

  get isShadow(): boolean {
    return this.shadow !== undefined;
  }

  assertShadowPath(): void {
    if (this.shadow) {
      assertMemoryShadowIdentity(this.shadow.path, this.shadow.identity);
    }
  }

  withPrivateAccess<T>(
    operation: () => T | Promise<T>,
    options: { nativeWriter?: boolean; reentrant?: boolean } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Memory reindex database owner is closed"));
    }
    return runQueuedStoreWrite({
      queues: this.privateQueues,
      storePath: this.shadow?.path ?? "memory-index",
      label: "private memory index access",
      // A Worker callback may inherit ALS, but it does not own a native write
      // permit. It must queue until the actual Worker operation settles.
      reentrant: options.reentrant === true && !this.nativeWriterActive,
      fn: async () => {
        if (!this.db.isOpen) {
          throw new Error("Memory reindex database owner is closed");
        }
        this.assertShadowPath();
        if (options.nativeWriter) {
          this.nativeWriterActive = true;
        }
        try {
          return await operation();
        } finally {
          if (options.nativeWriter) {
            this.nativeWriterActive = false;
          }
        }
      },
    });
  }

  private async drainPrivateAccess(): Promise<void> {
    while (this.privateQueues.size > 0) {
      await Promise.allSettled(
        Array.from(this.privateQueues.values()).flatMap((queue) =>
          queue.drainPromise ? [queue.drainPromise] : [],
        ),
      );
    }
  }

  private publicationState(): MemoryPublicationState {
    return {
      vector: { enabled: this.vector.enabled, available: this.vector.available },
      fts: { enabled: this.fts.enabled, available: this.fts.available },
      ...(this.vector.available && this.vector.extensionPath
        ? { extensionPath: this.vector.extensionPath }
        : {}),
    };
  }

  private assertPublishedFileCurrent(): void {
    if (this.closed || !this.db.isOpen || !this.writeOptions?.path) {
      throw new Error("Memory publication owner closed or changed");
    }
    const source = readOpenClawAgentDatabaseIdentity({ db: this.db });
    const current = readMemoryShadowIdentity(this.writeOptions.path);
    if (source.identity !== `${current.device}:${current.inode}`) {
      throw new Error("Memory publication source file changed");
    }
  }

  private getPublicationWorker(): Promise<PublicationWorker> {
    this.publicationWorker ??= (async () => {
      const filename = this.shadow?.path ?? this.writeOptions?.path;
      if (!filename || this.readOnly || this.closed) {
        throw new Error("Memory publication requires its live file owner");
      }
      if (this.writeOptions) {
        this.assertPublishedFileCurrent();
        const store = await openOpenClawAgentSqliteWorkerStoreV2<MemoryPublicationOperations>(
          this.writeOptions,
          {
            version: 2,
            assertCurrent: () => {
              if (this.closed || !this.db.isOpen) {
                throw new Error("Memory publication owner closed");
              }
            },
          },
          {
            moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
            input: { kind: "agent" },
          },
        );
        return { store, busyTimeoutMs: 5_000 };
      }
      const pragmas = this.shadow!.pragmas;
      const worker = {
        moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
        input: {
          fileIdentity: this.shadow?.identity ?? readMemoryShadowIdentity(filename),
          pragmas,
        },
      };
      const store = await openSqliteWorkerStore<MemoryPublicationOperations>({
        ...worker,
        databasePath: filename,
        existingOnly: true,
        admission: {
          identity: `file:${this.shadow!.identity.device}:${this.shadow!.identity.inode}`,
          assertCurrent: () => {
            if (this.closed || !this.db.isOpen) {
              throw new Error("Memory shadow owner closed before Worker open");
            }
            this.assertShadowPath();
          },
        },
      });
      if (!store) {
        throw new Error("Memory shadow disappeared before publication Worker open");
      }
      return this.bindShadowWorker(store, pragmas.busy_timeout);
    })().catch((error: unknown) => {
      // Open failure has already drained its native owner, or retained failed
      // cleanup with the agent lifecycle. It must not poison future attempts.
      this.publicationWorker = undefined;
      throw error;
    });
    return this.publicationWorker;
  }

  private bindShadowWorker(
    store: SqliteWorkerStore<MemoryPublicationOperations>,
    busyTimeoutMs: number,
  ): PublicationWorker {
    const run = <T>(
      operation: (scope: PublicationScope) => Promise<T>,
      assertCurrent: () => void,
    ) =>
      runSqliteWorkerStoreWrite(
        store,
        operation,
        () => {
          if (this.closed || !this.db.isOpen) {
            throw new Error("Memory shadow owner closed");
          }
          this.assertShadowPath();
          assertCurrent();
        },
        [this.shadow!.path],
      );
    return {
      store: {
        run,
        execute: (command, assertCurrent, options) =>
          run((scope) => scope.execute(command, options), assertCurrent),
        close: () => store.close(),
      },
      busyTimeoutMs,
    };
  }

  private withPublicationWorker<T>(
    operation: (store: PublicationWorker["store"]) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T> {
    const run = async () => {
      assertCurrent();
      try {
        const worker = await this.getPublicationWorker();
        return await operation(worker.store);
      } catch (error) {
        const [cleanup] = await Promise.allSettled([this.closePublicationWorker()]);
        if (cleanup.status === "rejected") {
          throw new AggregateError(
            [error, cleanup.reason],
            `${String(error)}; Memory publication cleanup failed: ${String(cleanup.reason)}`,
            { cause: error },
          );
        }
        throw error;
      }
    };
    return this.isShadow
      ? this.withPrivateAccess(run, { nativeWriter: true, reentrant: true })
      : run();
  }

  private runPublication<T>(
    operation: (scope: PublicationScope) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T> {
    return this.withPublicationWorker(
      (store) => store.run(operation, assertCurrent),
      assertCurrent,
    );
  }

  private executePublication<Key extends keyof MemoryPublicationOperations>(
    command: { type: Key; input: MemoryPublicationOperations[Key]["input"] },
    assertCurrent: () => void,
  ): Promise<MemoryPublicationOperations[Key]["output"]> {
    return this.withPublicationWorker(
      (store) => store.execute(command, assertCurrent),
      assertCurrent,
    );
  }

  private async retryPublication<T>(
    run: () => Promise<MemoryPublicationResult<T>>,
    prepare: () => Promise<boolean> = async () => true,
  ): Promise<T | undefined> {
    const worker = await this.getPublicationWorker();
    const result = await retryMemoryPublication({
      run,
      busyTimeoutMs: worker.busyTimeoutMs,
      prepare,
    });
    if (result?.facts) {
      this.installFacts(result.facts, result.writeToken);
    }
    return result?.value;
  }

  read<Key extends "source.hash" | "source.chunks" | "cache.read" | "session.current">(
    command: { type: Key; input: MemoryPublicationOperations[Key]["input"] },
    assertCurrent: () => void,
  ): Promise<MemoryPublicationOperations[Key]["output"]> {
    return this.executePublication(command, assertCurrent);
  }

  admitSchema(input: MemoryPublicationOperations["schema.admit"]["input"]): Promise<void> {
    this.schemaAdmission ??= this.runPublication(
      (scope) => this.retryPublication(() => scope.execute({ type: "schema.admit", input })),
      () => {
        if (this.closed || !this.db.isOpen) {
          throw new Error("Memory database owner closed before schema admission");
        }
      },
    ).then((result) => {
      if (!result) {
        throw new Error("Memory schema admission did not complete");
      }
      this.fts.enabled = input.ftsEnabled;
      this.fts.available = result.ftsAvailable;
      this.fts.loadError = result.ftsError;
      if (input.ftsEnabled && result.ftsError) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    });
    return this.schemaAdmission;
  }

  async readSourceState(query: Omit<Parameters<typeof loadMemorySourceFileState>[0], "db">) {
    const assertCurrent = () => {
      if (this.closed || !this.db.isOpen) {
        throw new Error("Memory source owner closed during source preparation");
      }
      this.assertShadowPath();
    };
    assertCurrent();
    if (!this.hasIndex) {
      return [];
    }
    let rows;
    if (this.readOnly) {
      const target = this.writeOptions;
      if (!target?.agentId || !target.path) {
        throw new Error("Memory source inspection requires its captured database target");
      }
      rows = await runMemorySourceState(
        { agentId: target.agentId, databasePath: target.path },
        query,
      );
    } else {
      rows = await this.executePublication({ type: "source.state", input: query }, assertCurrent);
    }
    assertCurrent();
    return rows;
  }

  async pruneEmbeddingCache(maxEntries: number, assertCurrent: () => void): Promise<boolean> {
    assertCurrent();
    // Each failed BEGIN releases admission before retry; successful batches yield at the caller.
    return (
      (await this.retryPublication(() =>
        this.executePublication({ type: "cache.prune", input: { maxEntries } }, assertCurrent),
      )) ?? false
    );
  }

  async mutateEmbeddingCache(
    mutation: MemoryEmbeddingCacheMutation,
    assertCurrent: () => void,
    prepareRevision: () => number | undefined,
    invalidate: () => void,
  ): Promise<boolean | undefined> {
    const publish = (scope: PublicationScope) =>
      publishMemoryEmbeddingCache({
        scope,
        mutation,
        prepareRevision,
        invalidate,
        retry: (run, prepare) => this.retryPublication(run, prepare),
      });
    return mutation.kind === "clear" ||
      memoryEmbeddingCacheFitsInline(mutation.header, mutation.entries)
      ? publish({ execute: (command) => this.executePublication(command, assertCurrent) })
      : this.runPublication(publish, assertCurrent);
  }

  async replaceSource(
    replacement: MemorySourceIndexReplacement,
    assertCurrent: () => void,
    prepare: () => Promise<boolean>,
  ) {
    return this.withSourceMutation(() =>
      publishMemorySource({
        replacement,
        state: () => this.publicationState(),
        execute: (command) => this.executePublication(command, assertCurrent),
        run: (operation) => this.runPublication(operation, assertCurrent),
        retry: (run, prepareRetry) => this.retryPublication(run, prepareRetry),
        prepare,
        assertPublished: this.isShadow ? assertCurrent : undefined,
      }),
    );
  }

  async deleteSource(
    input: Omit<MemoryPublicationOperations["source.delete"]["input"], "state">,
    assertCurrent: () => void,
  ) {
    const run = () =>
      this.runPublication(
        (scope) =>
          this.retryPublication(() =>
            scope.execute({
              type: "source.delete",
              input: { ...input, state: this.publicationState() },
            }),
          ),
        assertCurrent,
      );
    return this.withSourceMutation(run);
  }

  refreshSourceState(
    input: MemoryPublicationOperations["source.refresh"]["input"],
    assertCurrent: () => void,
  ) {
    return this.withSourceMutation(() =>
      this.runPublication(
        (scope) => this.retryPublication(() => scope.execute({ type: "source.refresh", input })),
        assertCurrent,
      ),
    );
  }

  refreshSourceOrigin(
    input: MemoryPublicationOperations["source.refreshOrigin"]["input"],
    assertCurrent: () => void,
    prepare: () => Promise<boolean>,
  ) {
    return this.withSourceMutation(() =>
      this.runPublication(
        (scope) =>
          // Read live provenance after the writer FIFO admits this refresh.
          this.retryPublication(
            () => scope.execute({ type: "source.refreshOrigin", input }),
            prepare,
          ),
        assertCurrent,
      ),
    );
  }

  async updateIndexStructure<Key extends "vector.ensure" | "vector.retireLegacy">(
    command: { type: Key; input: MemoryPublicationOperations[Key]["input"] },
    assertCurrent: () => void,
  ) {
    return this.retryPublication<boolean | void>(() =>
      this.executePublication(command, assertCurrent),
    );
  }

  private withSourceMutation<T>(run: () => Promise<T>): Promise<T> {
    return this.writeOptions?.path
      ? withMemoryIndexGeneration(this.writeOptions.path, "mutation", run)
      : run();
  }

  async publishShadow(
    input: Omit<MemoryPublicationOperations["database.publish"]["input"], "state"> & {
      extensionPath?: string;
    },
    assertCurrent: () => void,
  ) {
    await this.runPublication(
      (scope) =>
        this.retryPublication(() =>
          scope.execute({
            type: "database.publish",
            input: {
              ...input,
              state: {
                ...this.publicationState(),
                extensionPath: input.sourceHasVectors ? input.extensionPath : undefined,
              },
            },
          }),
        ),
      assertCurrent,
    );
  }

  async closePublicationWorker(): Promise<void> {
    if (this.publicationWorker) {
      const worker = await this.publicationWorker;
      await worker.store.close();
      this.publicationWorker = undefined;
    }
  }

  async withPublicationGeneration(run: () => Promise<void>): Promise<void> {
    let execution: OpenClawAgentDatabaseExecution | undefined;
    if (
      this.writeOptions &&
      !this.readOnly &&
      supportsOpenClawAgentDatabaseExecution(this.writeOptions)
    ) {
      const source = readOpenClawAgentDatabaseIdentity({ db: this.db });
      if (this.closed || !this.db.isOpen || typeof source.identity !== "string") {
        throw new Error("Memory publication requires its live file owner");
      }
      // Retain across fallback preparation; a no-op generation never opens a native worker.
      execution = captureOpenClawAgentDatabaseExecution(this.writeOptions, {
        expectedIdentity: {
          kind: "file",
          physicalIdentity: source.identity,
          nativeLocation: source.filename,
          birthtime: source.birthtime,
        },
      });
    }
    const failures: unknown[] = [];
    for (const settle of [run, () => execution?.release()]) {
      try {
        await settle();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `${String(failures[0])}; Memory sync cleanup failed`, {
        cause: failures[0],
      });
    }
  }

  closeShadow(): Promise<void> {
    this.closed = true;
    this.shadowClose ??= (async () => {
      await this.drainPrivateAccess();
      await this.closePublicationWorker();
      // Each accepted pool task has closed its native database or joined Worker
      // termination before its promise releases this private admission.
      this.release();
      this.shadowReleased = true;
    })().catch((error: unknown) => {
      this.shadowClose = undefined;
      throw error;
    });
    return this.shadowClose;
  }
}
