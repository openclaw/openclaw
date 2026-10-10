import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtensionFromPath,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  stopMemorySqliteWalMaintenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  assertTransactionUsable,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  requestSqliteWorkerOperationAdmission,
  runSqliteImmediateTransactionSync,
  supportsNodeSqliteExtensionLoading,
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
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import { MEMORY_INDEX_META_KEY, readMemoryIndexMetadata } from "./manager-retrieval-read.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  type MemoryShadowConnection,
  type MemoryShadowFailure,
} from "./manager-shadow-task.js";
import {
  MemorySourceIndexKernel,
  readMemorySourceHash,
  type MemorySourceIndexHeader,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import {
  loadMemorySourceFileState,
  refreshMemorySessionSourceState,
} from "./manager-source-state.js";
import { memoryTableExists } from "./manager-vector-rebuild-state.js";

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
      pragmas: readConnectionPragmas(db),
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
  const connection =
    "kind" in input
      ? {
          fileIdentity: readMemoryShadowIdentity(context.databasePath),
          pragmas: readConnectionPragmas(db),
        }
      : input;
  return createPublicationBackend(connection, context.databasePath, db, false, (stage) =>
    context.admit(stage),
  );
}

function readConnectionPragmas(db: DatabaseSync): MemoryShadowConnection["pragmas"] {
  const read = (name: keyof MemoryShadowConnection["pragmas"]): number => {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const value = row?.[name] ?? row?.timeout;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error("Invalid memory publication connection policy");
    }
    return value;
  };
  return {
    busy_timeout: read("busy_timeout"),
    synchronous: read("synchronous"),
    foreign_keys: read("foreign_keys"),
    journal_size_limit: read("journal_size_limit"),
    checkpoint_fullfsync: read("checkpoint_fullfsync"),
  };
}

function createPublicationBackend(
  input: MemoryShadowConnection,
  databasePath: string,
  db: DatabaseSync,
  ownsConnection: boolean,
  admit: (stage: "transaction" | "commit") => void,
) {
  const assertPath = () => assertMemoryShadowIdentity(databasePath, input.fileIdentity);
  let staged:
    | ({
        operation: string;
        rows: number;
        row: number;
        part: number;
      } & (
        | { kind: "source"; header: MemorySourceIndexHeader }
        | { kind: "cache"; header: MemoryEmbeddingCacheHeader }
      ))
    | undefined;
  let loadedExtension: string | undefined;
  assertPath();
  for (const [name, value] of Object.entries(input.pragmas)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Invalid memory publication connection policy");
    }
    if (ownsConnection) {
      db.exec(`PRAGMA ${name} = ${value}`);
    }
  }
  // Connection-local scratch spills to SQLite's temporary storage instead of
  // retaining a second complete source in the Worker or its broker queue.
  if (ownsConnection) {
    db.exec("PRAGMA temp_store = FILE");
  }
  let inputTableCreated = false;
  let insert: StatementSync | undefined;
  const discard = () => {
    db.exec("DELETE FROM temp.memory_publication_input");
    staged = undefined;
  };
  const finish = <T>(outcome: MemoryPublicationResult<T>): MemoryPublicationResult<T> => {
    // Failed commands close through their host owner; cleanup must not hide the write outcome.
    if (outcome.ok) {
      try {
        discard();
      } catch (error) {
        return { ok: false, error: failure(error), entered: true, committed: true };
      }
    }
    return outcome;
  };
  const transact = <T>(
    run: (hooks: { onBegin: () => void; withCommit: (commit: () => void) => void }) => T,
  ): MemoryPublicationResult<T> => {
    let entered = false;
    let committed = false;
    let restoredBusyTimeout = false;
    const restoreBusyTimeout = () => {
      if (!restoredBusyTimeout) {
        db.exec(`PRAGMA busy_timeout = ${input.pragmas.busy_timeout}`);
        restoredBusyTimeout = true;
      }
    };
    try {
      assertPath();
      // Failed BEGIN is returned to the preparing host without sleeping here.
      // It revalidates memory-file input before every retry, as before.
      db.exec("PRAGMA busy_timeout = 0");
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
          commit();
          committed = true;
        },
      });
      return { ok: true, value };
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
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Memory publication left an unsettled native connection");
      }
    },
    execute(command) {
      assertPath();
      if (command.type === "connection.inspect") {
        return input;
      }
      if (command.type === "schema.admit") {
        // Storage/STRICT migration must disable foreign keys before BEGIN.
        db.exec("PRAGMA foreign_keys = OFF");
        try {
          return write(() => ensureMemoryIndexSchema({ ...command.input, db }));
        } finally {
          if (db.isOpen) {
            db.exec(`PRAGMA foreign_keys = ${input.pragmas.foreign_keys}`);
          }
        }
      }
      if (command.type === "source.hash") {
        return readMemorySourceHash(db, command.input.source, command.input.path);
      }
      if (command.type === "meta.write") {
        return write(() => writeMeta(JSON.stringify(command.input.meta)));
      }
      if (command.type === "source.state") {
        return loadMemorySourceFileState({ db, ...command.input });
      }
      if (command.type === "source.refresh") {
        return write(() => refreshMemorySessionSourceState(db, command.input));
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
        if (!inputTableCreated) {
          db.exec(
            "CREATE TEMP TABLE memory_publication_input (row INTEGER NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (row, part)) WITHOUT ROWID",
          );
          inputTableCreated = true;
        }
        staged =
          command.type === "stage.start"
            ? { ...command.input, kind: "source", row: 0, part: 0 }
            : { ...command.input, kind: "cache", row: 0, part: 0 };
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
          (insert ??= db.prepare(
            "INSERT INTO temp.memory_publication_input (row, part, json) VALUES (?, ?, ?)",
          )).run(fragment.row, fragment.part, fragment.json);
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
      if (command.type === "cache.write") {
        if (
          !staged ||
          staged.kind !== "cache" ||
          staged.operation !== command.input.operation ||
          staged.row !== staged.rows ||
          staged.part !== 0
        ) {
          throw new Error("Memory cache input was not sealed");
        }
        const header = staged.header;
        return finish(
          write(() => {
            if (readMemoryDatabaseRevision(db) !== command.input.expectedRevision) {
              return false;
            }
            const eligible = new Map<string, boolean>();
            function* entries() {
              for (const entry of readStagedRows<MemoryEmbeddingCacheEntry>(db)) {
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
          }),
        );
      }
      const extensionPath = command.input.state.extensionPath;
      if (extensionPath && extensionPath !== loadedExtension) {
        loadSqliteVecExtensionFromPath(db, extensionPath);
        assertPath();
        loadedExtension = extensionPath;
      }
      if (command.type === "vector.retireLegacy") {
        if (!memoryTableExists(db, "chunks_vec")) {
          return { ok: true, value: false };
        }
        return write(() => {
          db.exec("DROP TABLE IF EXISTS chunks_vec");
          return true;
        });
      }
      if (command.type === "vector.ensure") {
        const { dimensions } = command.input;
        if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
          throw new Error("Memory vector dimensions must be a positive integer");
        }
        const { meta } = readMemoryIndexMetadata(db);
        const currentDimensions = meta ? meta.vectorDims : command.input.currentDimensions;
        if (currentDimensions === dimensions && memoryTableExists(db, MEMORY_INDEX_VECTOR_TABLE)) {
          return { ok: true, value: undefined };
        }
        return write(() => {
          db.exec(`DROP TABLE IF EXISTS ${MEMORY_INDEX_VECTOR_TABLE}`);
          db.exec(
            `CREATE VIRTUAL TABLE ${MEMORY_INDEX_VECTOR_TABLE} USING vec0(\n` +
              `  id TEXT PRIMARY KEY,\n  embedding FLOAT[${dimensions}]\n)`,
          );
          if (
            meta &&
            !meta.vectorDims &&
            !db.prepare("SELECT 1 FROM memory_index_chunks LIMIT 1").get()
          ) {
            writeMeta(JSON.stringify({ ...meta, vectorDims: dimensions }));
          }
        });
      }
      if (command.type === "database.publish") {
        const publication = command.input;
        return transact((hooks) => {
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
        });
      }
      if (command.type === "source.delete") {
        return write(() =>
          new MemorySourceIndexKernel(db, command.input.state).deleteIfCurrent(command.input),
        );
      }
      if (
        !staged ||
        staged.kind !== "source" ||
        staged.operation !== command.input.operation ||
        staged.row !== staged.rows ||
        staged.part !== 0
      ) {
        throw new Error("Memory publication input was not sealed");
      }
      const header = staged.header;
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
        new MemorySourceIndexKernel(db, command.input.state).replaceRows(
          header,
          readStagedRows<MemorySourceIndexRow>(db),
        );
        return { beforeRevision, databaseRevision: readMemoryDatabaseRevision(db) };
      });
      return finish(outcome);
    },
    close() {
      if (inputTableCreated) {
        db.exec("DROP TABLE temp.memory_publication_input");
        inputTableCreated = false;
      }
    },
  } satisfies SqliteWorkerBackend<MemoryPublicationOperations>;
}

function* readStagedRows<Row extends MemorySourceIndexRow | MemoryEmbeddingCacheEntry>(
  db: DatabaseSync,
): Generator<Row> {
  // SAFETY: Only the paired source/cache producer writes these sealed records.
  const parse = (parts: string[]) => JSON.parse(parts.join("")) as Row;
  let parts: string[] = [];
  let row = 0;
  for (const fragment of db
    .prepare("SELECT row, json FROM temp.memory_publication_input ORDER BY row, part")
    .iterate()) {
    if (fragment.row !== row) {
      yield parse(parts);
      parts = [];
      row = Number(fragment.row);
    }
    parts.push(String(fragment.json));
  }
  if (parts.length) {
    yield parse(parts);
  }
}
