import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtensionFromPath,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  loadSqliteVecExtension,
  stopMemorySqliteWalMaintenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  assertTransactionUsable,
  admitSqliteSchema,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  requestSqliteWorkerOperationAdmission,
  readSqliteDatabasePendingWriteToken,
  readSqliteDatabaseWriteTokenForPath,
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
  setSqliteBusyTimeout,
  supportsNodeSqliteExtensionLoading,
  tableExists,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { hasMemorySessionTombstone } from "../memory-session-tombstones.js";
import { publishMemoryDatabaseTables, readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import {
  clearMemoryEmbeddingCacheIdentities,
  countMemoryEmbeddingCache,
  loadMemoryEmbeddingCache,
  pruneMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";
import type {
  MemoryEmbeddingCacheEntry,
  MemoryEmbeddingCacheHeader,
  MemoryPublicationConnection,
  MemoryPublicationFragment,
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import { MEMORY_INDEX_META_KEY, readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  readMemoryConnectionPragmas,
  type MemoryShadowConnection,
  type MemoryShadowFailure,
} from "./manager-shadow-task.js";
import {
  MemorySourceIndexKernel,
  readMemorySourceChunks,
  readMemorySourceHash,
  type MemorySourceIndexHeader,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import {
  loadMemorySourceFileState,
  refreshMemorySessionSourceState,
} from "./manager-source-state.js";

type PublicationConnection =
  | MemoryShadowConnection
  | {
      kind: "agent";
      fileIdentity: MemoryShadowConnection["fileIdentity"];
      pragmas: Pick<MemoryShadowConnection["pragmas"], "busy_timeout" | "foreign_keys">;
    };

// The agent owner configures these once; temporary transaction settings restore them.
const agentConnectionPragmas = new WeakMap<
  DatabaseSync,
  Pick<MemoryShadowConnection["pragmas"], "busy_timeout" | "foreign_keys">
>();
const loadedExtensions = new WeakMap<DatabaseSync, string>();

function failure(error: unknown): MemoryShadowFailure {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...(error &&
    typeof error === "object" &&
    "errcode" in error &&
    typeof error.errcode === "number"
      ? { errcode: error.errcode }
      : {}),
  };
}

export function createSqliteWorkerBackend(
  input: { allowExtension: boolean },
  context: { databasePath: string },
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  return openShadowBackend(context.databasePath, input.allowExtension);
}

export function openExistingSqliteWorkerBackend(
  input: MemoryShadowConnection,
  context: { databasePath: string },
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  assertMemoryShadowIdentity(context.databasePath, input.fileIdentity);
  return openShadowBackend(context.databasePath, true, input);
}

async function openShadowBackend(
  databasePath: string,
  allowExtension: boolean,
  existing?: MemoryShadowConnection,
): Promise<SqliteWorkerBackend<MemoryPublicationOperations>> {
  const db = openNodeSqliteDatabase(
    existing ? resolveExistingSqliteFileUri(databasePath) : databasePath,
    {
      allowExtension: allowExtension && !process.permission && supportsNodeSqliteExtensionLoading(),
    },
  );
  const close = async () => {
    await stopMemorySqliteWalMaintenance(db);
    try {
      closeMemorySqliteWalMaintenance(db);
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  };
  try {
    configureMemorySqliteWalMaintenance(db, { busyTimeoutMs: 5_000, databasePath });
    const connection = existing ?? {
      fileIdentity: readMemoryShadowIdentity(databasePath),
      pragmas: readMemoryConnectionPragmas(db, "Invalid memory publication connection policy"),
    };
    return {
      ...createPublicationBackend(connection, databasePath, db, true, (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Agent publication borrows its executor connection; only private shadows open their own. */
export function bindSqliteWorkerBackend(
  input: MemoryPublicationConnection,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
) {
  const db = context.database;
  let pragmas = agentConnectionPragmas.get(db);
  if ("kind" in input && !pragmas) {
    pragmas = {
      busy_timeout: readConnectionPragma(db, "busy_timeout"),
      foreign_keys: readConnectionPragma(db, "foreign_keys"),
    };
    agentConnectionPragmas.set(db, pragmas);
  }
  const connection: PublicationConnection =
    "kind" in input
      ? {
          kind: "agent",
          fileIdentity: readMemoryShadowIdentity(context.databasePath),
          pragmas: pragmas!,
        }
      : input;
  return createPublicationBackend(connection, context.databasePath, db, false, (stage) =>
    context.admit(stage),
  );
}

function readConnectionPragma(
  db: DatabaseSync,
  name: keyof MemoryShadowConnection["pragmas"],
): number {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = row?.[name] ?? row?.timeout;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Invalid memory publication connection policy");
  }
  return value;
}

function createPublicationBackend(
  input: PublicationConnection,
  databasePath: string,
  db: DatabaseSync,
  ownsConnection: boolean,
  admit: (stage: "transaction" | "commit") => void,
) {
  const assertPath = () => assertMemoryShadowIdentity(databasePath, input.fileIdentity);
  // One source owns this staging buffer until settlement. Large sources cost
  // additional worker memory, but never turn transfer fragments into SQLite I/O.
  let staged:
    | ({
        operation: string;
        rows: number;
        row: number;
        part: number;
        fragments: MemoryPublicationFragment[];
      } & (
        | { kind: "source"; header: MemorySourceIndexHeader }
        | { kind: "cache"; header: MemoryEmbeddingCacheHeader }
      ))
    | undefined;
  const loadExtension = (extensionPath: string | undefined) => {
    if (extensionPath && extensionPath !== loadedExtensions.get(db)) {
      loadSqliteVecExtensionFromPath(db, extensionPath);
      assertPath();
      loadedExtensions.set(db, extensionPath);
    }
  };
  assertPath();
  for (const [name, value] of Object.entries(input.pragmas)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Invalid memory publication connection policy");
    }
    if (ownsConnection) {
      if (name === "busy_timeout") {
        setSqliteBusyTimeout(db, value);
      } else {
        db.exec(`PRAGMA ${name} = ${value}`);
      }
    }
  }
  const discard = () => {
    staged = undefined;
  };
  const finish = <T>(outcome: MemoryPublicationResult<T>): MemoryPublicationResult<T> => {
    if (outcome.ok) {
      discard();
    }
    return outcome;
  };
  const transact = <T>(
    run: (hooks: { onBegin: () => void; withCommit: (commit: () => void) => void }) => T,
  ): MemoryPublicationResult<T> => {
    let entered = false;
    let committed = false;
    let writeToken: string | undefined;
    let restoredBusyTimeout = false;
    const restoreBusyTimeout = () => {
      if (!restoredBusyTimeout) {
        setSqliteBusyTimeout(db, input.pragmas.busy_timeout);
        restoredBusyTimeout = true;
      }
    };
    try {
      assertPath();
      // Failed BEGIN is returned to the preparing host without sleeping here.
      // It revalidates memory-file input before every retry, as before.
      setSqliteBusyTimeout(db, 0);
      const value = run({
        onBegin: () => {
          entered = true;
          restoreBusyTimeout();
          assertPath();
          admit("transaction");
        },
        withCommit: (commit) => {
          assertPath();
          admit("commit");
          writeToken = readSqliteDatabasePendingWriteToken(db);
          commit();
          committed = true;
        },
      });
      return { ok: true, value, writeToken };
    } catch (error) {
      return { ok: false, error: failure(error), entered, committed };
    } finally {
      if (db.isOpen) {
        restoreBusyTimeout();
      }
    }
  };
  const write = <T>(run: () => T): MemoryPublicationResult<T> =>
    transact((hooks) =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          hooks.onBegin();
          return run();
        },
        { withCommit: hooks.withCommit },
      ),
    );
  const writeSingleStatement = <T>(statement: () => T): MemoryPublicationResult<T> => {
    let entered = false;
    let committed = false;
    let restoredBusyTimeout = true;
    const restoreBusyTimeout = () => {
      if (!restoredBusyTimeout) {
        setSqliteBusyTimeout(db, input.pragmas.busy_timeout);
        restoredBusyTimeout = true;
      }
    };
    try {
      entered = true;
      admit("transaction");
      // Autocommit makes the statement the effect boundary.
      admit("commit");
      setSqliteBusyTimeout(db, 0);
      restoredBusyTimeout = false;
      let value: T;
      try {
        value = runSqliteSingleStatementSync(db, statement);
      } catch (error) {
        const nativeCode = failure(error).errcode;
        // Lock refusal leaves no durable write, so the preparing host may retry.
        entered = nativeCode === undefined || ![5, 6].includes(nativeCode & 0xff);
        throw error;
      }
      committed = true;
      const writeToken = readSqliteDatabaseWriteTokenForPath(databasePath);
      restoreBusyTimeout();
      return { ok: true, value, writeToken };
    } catch (error) {
      return { ok: false, error: failure(error), entered, committed };
    } finally {
      if (db.isOpen) {
        restoreBusyTimeout();
      }
    }
  };
  const withFacts = <T>(result: MemoryPublicationResult<T>): MemoryPublicationResult<T> =>
    result.ok ? { ...result, facts: readMemoryDatabaseFacts(db) } : result;
  const writeMeta = (value: string) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<{ memory_index_meta: { key: string; value: string } }>(db)
        .insertInto("memory_index_meta")
        .values({ key: MEMORY_INDEX_META_KEY, value })
        .onConflict((conflict) => conflict.column("key").doUpdateSet({ value })),
    );
  };
  return {
    async prepare(command) {
      if (command.type !== "vector.prepare") {
        return;
      }
      const extensionPath = command.input.state.extensionPath;
      const loadedPath = loadedExtensions.get(db);
      if (loadedPath && (!extensionPath || extensionPath === loadedPath)) {
        return;
      }
      // Module resolution can yield; the executor awaits preparation before
      // entering its synchronous operation and transaction admission.
      const loaded = await loadSqliteVecExtension({ db, extensionPath });
      if (!loaded.ok || !loaded.extensionPath) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      loadedExtensions.set(db, loaded.extensionPath);
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Memory publication left an unsettled native connection");
      }
    },
    execute(command) {
      assertPath();
      if (command.type === "connection.inspect") {
        return "kind" in input
          ? {
              fileIdentity: input.fileIdentity,
              pragmas: readMemoryConnectionPragmas(
                db,
                "Invalid memory publication connection policy",
              ),
            }
          : input;
      }
      if (command.type === "index.facts") {
        return readMemoryDatabaseFacts(db);
      }
      if (command.type === "schema.admit") {
        // Storage/STRICT migration must disable foreign keys before BEGIN.
        db.exec("PRAGMA foreign_keys = OFF");
        try {
          const result = write(() => ensureMemoryIndexSchema({ ...command.input, db }));
          if (result.ok) {
            admitSqliteSchema(db);
          }
          return withFacts(result);
        } finally {
          if (db.isOpen) {
            db.exec(`PRAGMA foreign_keys = ${input.pragmas.foreign_keys}`);
          }
        }
      }
      if (command.type === "source.hash") {
        return readMemorySourceHash(db, command.input.source, command.input.path);
      }
      if (command.type === "source.chunks") {
        return readMemorySourceChunks(db, command.input.source, command.input.path);
      }
      if (command.type === "index.writeMetadata") {
        const serialized = JSON.stringify(command.input);
        return withFacts(writeSingleStatement(() => writeMeta(serialized)));
      }
      if (command.type === "source.state") {
        return loadMemorySourceFileState({ db, ...command.input });
      }
      if (command.type === "source.refresh") {
        return withFacts(
          writeSingleStatement(() => refreshMemorySessionSourceState(db, command.input)),
        );
      }
      if (command.type === "session.current") {
        return hasMemorySessionTombstone(db, command.input.agentId, command.input.sessionId)
          ? "forgotten"
          : "current";
      }
      if (command.type === "cache.read") {
        return loadMemoryEmbeddingCache({ ...command.input, db });
      }
      if (command.type === "stage.start" || command.type === "cache.stage.start") {
        if (staged) {
          throw new Error("Memory publication input already belongs to another operation");
        }
        staged =
          command.type === "stage.start"
            ? { ...command.input, kind: "source", row: 0, part: 0, fragments: [] }
            : { ...command.input, kind: "cache", row: 0, part: 0, fragments: [] };
        return undefined;
      }
      if (command.type === "stage.discard") {
        if (staged?.operation === command.input.operation) {
          discard();
        }
        return undefined;
      }
      if (command.type === "stage.append") {
        if (!staged || staged.operation !== command.input.operation) {
          throw new Error("Memory publication input owner changed");
        }
        for (const fragment of command.input.fragments) {
          if (
            fragment.row !== staged.row ||
            fragment.part !== staged.part ||
            staged.row >= staged.rows
          ) {
            throw new Error("Memory publication input is incomplete or out of order");
          }
          staged.fragments.push(fragment);
          if (fragment.last) {
            staged.row++;
            staged.part = 0;
          } else {
            staged.part++;
          }
        }
        return undefined;
      }
      if (command.type === "cache.prune") {
        if (countMemoryEmbeddingCache(db) <= command.input.maxEntries) {
          return { ok: true, value: false };
        }
        return write(() => {
          pruneMemoryEmbeddingCache(db, command.input.maxEntries);
          return true;
        });
      }
      if (command.type === "cache.clear") {
        return write(() => {
          if (readMemoryDatabaseRevision(db) !== command.input.expectedRevision) {
            return false;
          }
          clearMemoryEmbeddingCacheIdentities(db, command.input.identities);
          return true;
        });
      }
      if (command.type === "cache.write" || command.type === "cache.write.inline") {
        let header: MemoryEmbeddingCacheHeader;
        let readEntries: () => Iterable<MemoryEmbeddingCacheEntry>;
        if (command.type === "cache.write.inline") {
          header = command.input.header;
          const entries = command.input.entries;
          readEntries = () => entries;
        } else {
          if (
            !staged ||
            staged.kind !== "cache" ||
            staged.operation !== command.input.operation ||
            staged.row !== staged.rows ||
            staged.part !== 0
          ) {
            throw new Error("Memory cache input was not sealed");
          }
          header = staged.header;
          const fragments = staged.fragments;
          readEntries = () => readPublicationRows<MemoryEmbeddingCacheEntry>(fragments);
        }
        const outcome = write(() => {
          if (readMemoryDatabaseRevision(db) !== command.input.expectedRevision) {
            return false;
          }
          const eligible = new Map<string, boolean>();
          function* entries() {
            for (const entry of readEntries()) {
              if (entry.sessionId) {
                let current = eligible.get(entry.sessionId);
                if (current === undefined) {
                  current = !hasMemorySessionTombstone(db, header.agentId, entry.sessionId);
                  eligible.set(entry.sessionId, current);
                }
                if (!current) {
                  continue;
                }
              }
              yield entry;
            }
          }
          upsertMemoryEmbeddingCache({ ...header, db, entries });
          return true;
        });
        return command.type === "cache.write" ? finish(outcome) : outcome;
      }
      if (command.type === "vector.prepare") {
        const loadedPath = loadedExtensions.get(db);
        if (!loadedPath) {
          throw new Error("Memory vector extension was not prepared");
        }
        if (!tableExists(db, "chunks_vec")) {
          return {
            ok: true,
            value: { extensionPath: loadedPath, retiredLegacy: false },
          };
        }
        return withFacts(
          write(() => {
            db.exec("DROP TABLE IF EXISTS chunks_vec");
            return { extensionPath: loadedPath, retiredLegacy: true };
          }),
        );
      }
      if (command.type === "vector.ensure") {
        const { dimensions } = command.input;
        if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
          throw new Error("Memory vector dimensions must be a positive integer");
        }
        const { meta, hasIndexedChunks } = readMemoryDatabaseFacts(db);
        const currentDimensions = meta ? meta.vectorDims : command.input.currentDimensions;
        if (currentDimensions === dimensions && tableExists(db, MEMORY_INDEX_VECTOR_TABLE)) {
          return { ok: true, value: undefined };
        }
        loadExtension(command.input.state.extensionPath);
        return withFacts(
          write(() => {
            db.exec(`DROP TABLE IF EXISTS ${MEMORY_INDEX_VECTOR_TABLE}`);
            db.exec(
              `CREATE VIRTUAL TABLE ${MEMORY_INDEX_VECTOR_TABLE} USING vec0(\n` +
                `  id TEXT PRIMARY KEY,\n  embedding FLOAT[${dimensions}]\n)`,
            );
            if (meta && !meta.vectorDims && !hasIndexedChunks) {
              writeMeta(JSON.stringify({ ...meta, vectorDims: dimensions }));
            }
          }),
        );
      }
      loadExtension(command.input.state.extensionPath);
      if (command.type === "database.publish") {
        const publication = command.input;
        return withFacts(
          transact((hooks) => {
            assertMemoryShadowIdentity(publication.sourcePath, publication.sourceIdentity);
            publishMemoryDatabaseTables({
              ...publication,
              targetDb: db,
              onBegin: () => {
                hooks.onBegin();
                assertMemoryShadowIdentity(publication.sourcePath, publication.sourceIdentity);
              },
              withCommit: hooks.withCommit,
            });
          }),
        );
      }
      if (command.type === "source.delete") {
        return withFacts(
          write(() =>
            new MemorySourceIndexKernel(db, command.input.state).deleteIfCurrent(command.input),
          ),
        );
      }
      let header: MemorySourceIndexHeader;
      let rows: Iterable<MemorySourceIndexRow>;
      if (command.type === "source.replace.inline") {
        header = command.input.header;
        rows = readPublicationRows<MemorySourceIndexRow>(command.input.fragments);
      } else {
        if (
          !staged ||
          staged.kind !== "source" ||
          staged.operation !== command.input.operation ||
          staged.row !== staged.rows ||
          staged.part !== 0
        ) {
          throw new Error("Memory publication input was not sealed");
        }
        header = staged.header;
        rows = readPublicationRows<MemorySourceIndexRow>(staged.fragments);
      }
      let facts: ReturnType<typeof readMemoryDatabaseFacts> | undefined;
      const outcome = write(() => {
        if (
          header.source === "sessions" &&
          hasMemorySessionTombstone(db, header.agentId, header.sessionId)
        ) {
          throw new Error(
            "A session was forgotten while memory indexing was running; retry the memory index.",
          );
        }
        const beforeRevision = readMemoryDatabaseRevision(db);
        const { retainedDrift } = new MemorySourceIndexKernel(db, command.input.state).replaceRows(
          header,
          rows,
        );
        facts = readMemoryDatabaseFacts(db);
        return {
          beforeRevision,
          databaseRevision: facts.revision,
          retainedDrift,
        };
      });
      const published = outcome.ok ? { ...outcome, facts } : outcome;
      return command.type === "source.replace.inline" ? published : finish(published);
    },
    close() {
      discard();
    },
  } satisfies SqliteWorkerBackend<MemoryPublicationOperations>;
}

function* readPublicationRows<Row extends MemorySourceIndexRow | MemoryEmbeddingCacheEntry>(
  fragments: Iterable<MemoryPublicationFragment>,
): Generator<Row> {
  // SAFETY: Only the paired source/cache producer writes these sealed records.
  const parse = (parts: string[]) => JSON.parse(parts.join("")) as Row;
  let parts: string[] = [];
  let row = 0;
  for (const fragment of fragments) {
    if (fragment.row !== row) {
      yield parse(parts);
      parts = [];
      row = fragment.row;
    }
    parts.push(fragment.json);
  }
  if (parts.length) {
    yield parse(parts);
  }
}
