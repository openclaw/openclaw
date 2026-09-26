// Owns the published index state and the isolated lifetime of shadow reindex work.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveStateDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  borrowOpenClawAgentDatabase,
  openSqliteWorkerStore,
  openOpenClawAgentSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type OpenClawAgentSqliteWorkerStore,
  type SqliteWorkerStore,
  runQueuedStoreWrite,
  withOpenClawAgentDatabaseWrite,
  type StoreWriterQueue,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  openMemoryDatabaseReadOnlyAtPath,
} from "./manager-db.js";
import type {
  MemoryPublicationConnection,
  MemoryPublicationOperations,
  MemoryPublicationResult,
  MemoryPublicationState,
} from "./manager-publication-task.js";
import { memoryPublicationBatches } from "./manager-publication-transfer.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  type MemoryShadowConnection,
} from "./manager-shadow-task.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

type PublicationScope = Pick<SqliteWorkerStore<MemoryPublicationOperations>, "execute">;
type PublicationWorker = Pick<
  OpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>,
  "run" | "close"
>;

export class MemoryIndexDatabase {
  private readonly privateQueues = new Map<string, StoreWriterQueue>();
  private nativeWriterActive = false;
  private publicationWorker?: Promise<PublicationWorker>;
  private shadow?: {
    path: string;
    identity: MemoryShadowConnection["fileIdentity"];
    pragmas: MemoryShadowConnection["pragmas"];
  };
  private shadowClose?: Promise<void>;
  private releaseInProgress = false;
  shadowReleased = false;

  static openPublished(params: {
    agentId: string;
    writeOptions: Parameters<typeof withOpenClawAgentDatabaseWrite>[0] & { path: string };
    readOnly: boolean;
    allowExtension: boolean;
    maintenanceSource?: MemoryIndexDatabase;
  }): MemoryIndexDatabase {
    const connection = params.readOnly
      ? openMemoryDatabaseReadOnlyAtPath(
          params.writeOptions.path,
          params.allowExtension,
          params.agentId,
        )
      : borrowOpenClawAgentDatabase(params.writeOptions);
    if (params.maintenanceSource && connection.db !== params.maintenanceSource.db) {
      connection.release();
      throw new Error("Memory maintenance source connection changed");
    }
    return new MemoryIndexDatabase(
      connection.db,
      connection.release,
      params.readOnly,
      params.writeOptions,
    );
  }

  static openShadow(filename: string, allowExtension: boolean): MemoryIndexDatabase {
    let database: MemoryIndexDatabase | undefined;
    const db = openMemoryDatabaseAtPath(filename, allowExtension, (operation) =>
      database ? database.runMaintenance(operation) : operation(),
    );
    try {
      database = new MemoryIndexDatabase(db);
      const readPragma = (name: keyof MemoryShadowConnection["pragmas"]): number => {
        const row = db.prepare(`PRAGMA ${name}`).get();
        const value = name === "busy_timeout" ? (row?.busy_timeout ?? row?.timeout) : row?.[name];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new Error("Invalid memory shadow connection policy");
        }
        return value;
      };
      database.shadow = {
        path: filename,
        identity: readMemoryShadowIdentity(filename),
        pragmas: {
          busy_timeout: readPragma("busy_timeout"),
          synchronous: readPragma("synchronous"),
          foreign_keys: readPragma("foreign_keys"),
          wal_autocheckpoint: readPragma("wal_autocheckpoint"),
          journal_size_limit: readPragma("journal_size_limit"),
          checkpoint_fullfsync: readPragma("checkpoint_fullfsync"),
        },
      };
      return database;
    } catch (error) {
      closeMemoryDatabase(db);
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
  lastMetaSerialized: string | null = null;
  vectorDegradedWriteWarningShown = false;
  closed = false;

  constructor(
    readonly db: DatabaseSync,
    readonly release: () => void = () => closeMemoryDatabase(db),
    readonly readOnly = false,
    readonly writeOptions?: Parameters<typeof withOpenClawAgentDatabaseWrite>[0],
  ) {}

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
    options: { nativeWriter?: boolean; reentrant?: boolean; closingMaintenance?: boolean } = {},
  ): Promise<T> {
    if (this.closed && !options.closingMaintenance) {
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

  private runMaintenance(operation: () => boolean): boolean {
    let result = false;
    // The WAL owner reports this pass as pending; the accepted operation is
    // retained in private admission and drains before its connection closes.
    void this.withPrivateAccess(
      () => {
        result = operation();
        return result;
      },
      { reentrant: true, closingMaintenance: this.releaseInProgress },
    ).catch(() => undefined);
    return result;
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

  private getPublicationWorker(): Promise<PublicationWorker> {
    this.publicationWorker ??= (async () => {
      const filename = this.shadow?.path ?? this.writeOptions?.path;
      if (!filename || this.readOnly || this.closed) {
        throw new Error("Memory publication requires its live file owner");
      }
      const readPragma = (name: keyof MemoryPublicationConnection["pragmas"]): number => {
        const row = this.db.prepare("PRAGMA " + name).get();
        const value = row?.[name] ?? row?.timeout;
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new Error("Invalid memory connection policy");
        }
        return value;
      };
      const pragmas = this.shadow?.pragmas ?? {
        busy_timeout: readPragma("busy_timeout"),
        synchronous: readPragma("synchronous"),
        foreign_keys: readPragma("foreign_keys"),
        wal_autocheckpoint: readPragma("wal_autocheckpoint"),
        journal_size_limit: readPragma("journal_size_limit"),
        checkpoint_fullfsync: readPragma("checkpoint_fullfsync"),
      };
      const worker = {
        moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
        input: {
          fileIdentity: this.shadow?.identity ?? readMemoryShadowIdentity(filename),
          pragmas,
        },
      };
      if (this.writeOptions) {
        return openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(
          this.writeOptions,
          this.db,
          worker,
        );
      }
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
      return {
        run: <T>(operation: (scope: PublicationScope) => Promise<T>, assertCurrent: () => void) =>
          runSqliteWorkerStoreWrite(store, operation, assertCurrent, [filename]),
        close: () => store.close(),
      };
    })().catch((error: unknown) => {
      // Open failure has already drained its native owner, or retained failed
      // cleanup with the agent lifecycle. It must not poison future attempts.
      this.publicationWorker = undefined;
      throw error;
    });
    return this.publicationWorker;
  }

  private runPublication<T>(
    operation: (scope: PublicationScope) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T> {
    const run = async () => {
      assertCurrent();
      try {
        const worker = await this.getPublicationWorker();
        return await worker.run(operation, assertCurrent);
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
    return this.isShadow ? this.withPrivateAccess(run, { nativeWriter: true }) : run();
  }

  private async retryPublication<T>(
    run: () => Promise<MemoryPublicationResult<T>>,
    prepare: () => Promise<boolean> = async () => true,
  ): Promise<T | undefined> {
    const policy = this.db.prepare("PRAGMA busy_timeout").get();
    const deadline = performance.now() + Number(policy?.timeout ?? policy?.busy_timeout ?? 5000);
    while (await prepare()) {
      const result = await run();
      if (result.ok) {
        return result.value;
      }
      const code = result.error.errcode === undefined ? undefined : result.error.errcode & 0xff;
      if (result.entered || (code !== 5 && code !== 6) || performance.now() >= deadline) {
        throw Object.assign(
          result.error.name === "MemoryIndexRevisionConflictError"
            ? new MemoryIndexRevisionConflictError(result.error.message)
            : new Error(result.error.message),
          result.error,
          {
            entered: result.entered,
            committed: result.committed,
          },
        );
      }
      await delay(Math.min(25, Math.max(0, deadline - performance.now())));
    }
    return undefined;
  }

  async replaceSource(
    replacement: MemorySourceIndexReplacement,
    assertCurrent: () => void,
    prepare: () => Promise<boolean>,
  ) {
    return this.runPublication(async (scope) => {
      const operation = randomUUID();
      const { chunks, embeddings: _embeddings, ...header } = replacement;
      await scope.execute({
        type: "stage.start",
        input: { operation, header, rows: chunks.length },
      });
      let needsDiscard = true;
      for (const fragments of memoryPublicationBatches(replacement)) {
        await scope.execute({ type: "stage.append", input: { operation, fragments } });
      }
      const result = await this.retryPublication(async () => {
        const outcome = await scope.execute({
          type: "source.replace",
          input: { operation, state: this.publicationState() },
        });
        if (outcome.ok || outcome.entered) {
          needsDiscard = false;
        }
        return outcome;
      }, prepare);
      if (this.isShadow) {
        assertCurrent();
      }
      // Thrown failures close the Worker through runPublication. A further
      // command on that failed scope could hide the original write outcome.
      if (needsDiscard) {
        await scope.execute({ type: "stage.discard", input: { operation } });
      }
      return result;
    }, assertCurrent);
  }

  async deleteSource(
    input: Omit<MemoryPublicationOperations["source.delete"]["input"], "state">,
    assertCurrent: () => void,
  ) {
    return this.runPublication(
      (scope) =>
        this.retryPublication(() =>
          scope.execute({
            type: "source.delete",
            input: { ...input, state: this.publicationState() },
          }),
        ),
      assertCurrent,
    );
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
      await worker.close();
      this.publicationWorker = undefined;
    }
  }

  closeShadow(): Promise<void> {
    this.closed = true;
    this.shadowClose ??= (async () => {
      await this.drainPrivateAccess();
      await this.closePublicationWorker();
      // Each accepted pool task has closed its native database or joined Worker
      // termination before its promise releases this private admission.
      this.releaseInProgress = true;
      try {
        this.release();
      } finally {
        this.releaseInProgress = false;
      }
      await this.drainPrivateAccess();
      this.shadowReleased = true;
    })().catch((error: unknown) => {
      this.shadowClose = undefined;
      throw error;
    });
    return this.shadowClose;
  }
}

// One process-lifetime container; stores belong only to their awaited rebuild.
const reindexDatabase = new AsyncLocalStorage<{
  manager: MemoryManagerDatabaseContext;
  database: MemoryIndexDatabase;
}>();

export abstract class MemoryManagerDatabaseContext {
  protected abstract publishedDatabase: MemoryIndexDatabase;
  protected closed = false;

  protected async withDatabaseWrite<T>(write: () => T): Promise<T> {
    const database = this.database;
    const run = () => {
      if (this.closed || database.closed || !database.db.isOpen || this.database !== database) {
        throw new Error("Memory database owner closed or changed before write admission");
      }
      if (database.readOnly) {
        throw new Error("Memory status managers are read-only");
      }
      return write();
    };
    // A shadow index is private to its awaited rebuild; only the published
    // borrowed database shares the agent's reclamation/write admission owner.
    return database.writeOptions
      ? await withOpenClawAgentDatabaseWrite(database.writeOptions, run, database.db)
      : await database.withPrivateAccess(run, { reentrant: true });
  }

  protected async withDatabaseRead<T>(read: () => T): Promise<T> {
    const database = this.database;
    return database.isShadow ? database.withPrivateAccess(read) : read();
  }

  protected get database(): MemoryIndexDatabase {
    const context = reindexDatabase.getStore();
    const shadow = context?.manager === this ? context.database : undefined;
    if (shadow?.closed) {
      throw new Error("Memory reindex database context is closed");
    }
    return shadow ?? this.publishedDatabase;
  }

  protected get db(): DatabaseSync {
    return this.database.db;
  }

  protected get vector() {
    return this.database.vector;
  }

  protected get fts() {
    return this.database.fts;
  }

  protected withPublishedDatabase<T>(run: () => T): T {
    // Public calls can originate in reindex progress/provider callbacks. They
    // must never inherit the temporary writer or outlive its connection.
    return reindexDatabase.exit(run);
  }

  protected async withReindexDatabase<T>(
    database: MemoryIndexDatabase,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await reindexDatabase.run({ manager: this, database }, run);
      // Publication attaches the finished file only after its writer closes.
      await database.closeShadow();
      return result;
    } finally {
      try {
        await database.closeShadow();
      } catch {}
    }
  }
}
