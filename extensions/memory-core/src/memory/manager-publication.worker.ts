import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtensionFromPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  assertTransactionUsable,
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
  MemoryPublicationFragment,
  MemoryPublicationOperations,
  MemoryPublicationResult,
} from "./manager-publication-task.js";
import { assertMemoryShadowIdentity, type MemoryShadowFailure } from "./manager-shadow-task.js";
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

export function openExistingSqliteWorkerBackend(
  input: MemoryPublicationConnection,
  context: { databasePath: string },
): SqliteWorkerBackend<MemoryPublicationOperations> {
  const assertPath = () => assertMemoryShadowIdentity(context.databasePath, input.fileIdentity);
  assertPath();
  const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(context.databasePath), {
    allowExtension: !process.permission && supportsNodeSqliteExtensionLoading(),
  });
  return createPublicationBackend(input, context.databasePath, db, true, (stage) =>
    requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
  );
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
  return createPublicationBackend(input, context.databasePath, context.database, false, (stage) =>
    context.admit(stage),
  );
}

function createPublicationBackend(
  input: MemoryPublicationConnection,
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
  let loadedExtension: string | undefined;
  try {
    assertPath();
    for (const [name, value] of Object.entries(input.pragmas)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("Invalid memory publication connection policy");
      }
      if (ownsConnection) {
        db.exec(`PRAGMA ${name} = ${value}`);
      }
    }
    // Borrowed connections retain the canonical executor's installed policy.
    const discard = () => {
      staged = undefined;
    };
    const finish = <T>(outcome: MemoryPublicationResult<T>): MemoryPublicationResult<T> => {
      // Failed commands close through their host owner; cleanup must not hide the write outcome.
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
    return {
      assertSettled() {
        assertTransactionUsable(db);
        if (!db.isOpen || db.isTransaction) {
          throw new Error("Memory publication left an unsettled native connection");
        }
      },
      execute(command) {
        assertPath();
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
        if (command.type === "source.chunks") {
          return readMemorySourceChunks(db, command.input.source, command.input.path);
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
        const extensionPath = command.input.state.extensionPath;
        if (extensionPath && extensionPath !== loadedExtension) {
          loadSqliteVecExtensionFromPath(db, extensionPath);
          assertPath();
          loadedExtension = extensionPath;
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
          const { retainedDrift } = new MemorySourceIndexKernel(
            db,
            command.input.state,
          ).replaceRows(header, rows);
          return {
            beforeRevision,
            databaseRevision: readMemoryDatabaseRevision(db),
            retainedDrift,
          };
        });
        return command.type === "source.replace.inline" ? outcome : finish(outcome);
      },
      close() {
        if (ownsConnection) {
          db.close();
        }
        discard();
      },
    } satisfies SqliteWorkerBackend<MemoryPublicationOperations>;
  } catch (error) {
    if (ownsConnection) {
      db.close();
    }
    throw error;
  }
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
