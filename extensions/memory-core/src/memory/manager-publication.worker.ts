import type { DatabaseSync } from "node:sqlite";
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
import type {
  MemoryPublicationConnection,
  MemoryPublicationOperations,
  MemoryPublicationResult,
  MemoryPublicationState,
} from "./manager-publication-task.js";
import { assertMemoryShadowIdentity, type MemoryShadowFailure } from "./manager-shadow-task.js";
import {
  MemorySourceIndexKernel,
  type MemorySourceIndexHeader,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

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
  let staged:
    | {
        operation: string;
        header: MemorySourceIndexHeader;
        rows: number;
        row: number;
        part: number;
      }
    | undefined;
  let loadedExtension: string | undefined;
  try {
    assertPath();
    for (const [name, value] of Object.entries(input.pragmas)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("Invalid memory publication connection policy");
      }
      db.exec(`PRAGMA ${name} = ${value}`);
    }
    // Connection-local scratch spills to SQLite's temporary storage instead of
    // retaining a second complete source in the Worker or its broker queue.
    db.exec("PRAGMA temp_store = FILE");
    db.exec(
      "CREATE TEMP TABLE memory_publication_input (row INTEGER NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (row, part)) WITHOUT ROWID",
    );
    const insert = db.prepare(
      "INSERT INTO temp.memory_publication_input (row, part, json) VALUES (?, ?, ?)",
    );
    const discard = () => {
      db.exec("DELETE FROM temp.memory_publication_input");
      staged = undefined;
    };
    const configure = (state: MemoryPublicationState) => {
      if (state.extensionPath && state.extensionPath !== loadedExtension) {
        db.loadExtension(state.extensionPath);
        loadedExtension = state.extensionPath;
      }
    };
    const transact = <T>(
      run: (hooks: { onBegin: () => void; withCommit: (commit: () => void) => void }) => T,
    ): MemoryPublicationResult<T> => {
      let entered = false;
      let committed = false;
      try {
        assertPath();
        // Failed BEGIN is returned to the preparing host without sleeping here.
        // It revalidates memory-file input before every retry, as before.
        db.exec("PRAGMA busy_timeout = 0");
        const value = run({
          onBegin: () => {
            entered = true;
            db.exec(`PRAGMA busy_timeout = ${input.pragmas.busy_timeout}`);
            assertPath();
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          },
          withCommit: (commit) => {
            assertPath();
            requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
            commit();
            committed = true;
          },
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: failure(error), entered, committed };
      } finally {
        if (db.isOpen) {
          db.exec(`PRAGMA busy_timeout = ${input.pragmas.busy_timeout}`);
        }
      }
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
        if (command.type === "stage.start") {
          if (staged) {
            throw new Error("Memory publication input already belongs to another operation");
          }
          staged = { ...command.input, row: 0, part: 0 };
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
            insert.run(fragment.row, fragment.part, fragment.json);
            if (fragment.last) {
              staged.row++;
              staged.part = 0;
            } else {
              staged.part++;
            }
          }
          return undefined;
        }
        configure(command.input.state);
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
          return transact((hooks) =>
            runSqliteImmediateTransactionSync(
              db,
              () => {
                hooks.onBegin();
                return new MemorySourceIndexKernel(db, command.input.state).deleteIfCurrent(
                  command.input,
                );
              },
              { withCommit: hooks.withCommit },
            ),
          );
        }
        if (
          !staged ||
          staged.operation !== command.input.operation ||
          staged.row !== staged.rows ||
          staged.part !== 0
        ) {
          throw new Error("Memory publication input was not sealed");
        }
        const header = staged.header;
        const outcome = transact((hooks) =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              hooks.onBegin();
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
                readStagedRows(db),
              );
              return { beforeRevision, databaseRevision: readMemoryDatabaseRevision(db) };
            },
            { withCommit: hooks.withCommit },
          ),
        );
        // Failed publication closes the Worker at its host owner. Preserve the
        // transaction error instead of replacing it with a staging-cleanup error.
        if (outcome.ok) {
          try {
            discard();
          } catch (error) {
            return {
              ok: false,
              error: failure(error),
              entered: true,
              committed: true,
            };
          }
        }
        return outcome;
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function* readStagedRows(db: DatabaseSync): Generator<MemorySourceIndexRow> {
  let parts: string[] = [];
  let row = 0;
  for (const fragment of db
    .prepare("SELECT row, json FROM temp.memory_publication_input ORDER BY row, part")
    .iterate()) {
    if (fragment.row !== row) {
      // SAFETY: Only the paired typed producer writes these sealed JSON records.
      yield JSON.parse(parts.join("")) as MemorySourceIndexRow;
      parts = [];
      row = Number(fragment.row);
    }
    parts.push(String(fragment.json));
  }
  if (parts.length) {
    // SAFETY: Only the paired typed producer writes these sealed JSON records.
    yield JSON.parse(parts.join("")) as MemorySourceIndexRow;
  }
}
