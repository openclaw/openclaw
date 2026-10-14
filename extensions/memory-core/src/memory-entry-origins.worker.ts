import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryEntryOriginsSchema,
  loadSqliteVecExtensionFromPath,
  readMemoryEntryOriginsInDatabase,
  recordMemoryEntryOriginsInDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  assertTransactionUsable,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  tableExists,
  withSqlitePostCommitPublications,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { deleteMemoryEntryOriginsInDatabase } from "./memory-entry-origins-delete.js";
import type {
  MemoryEntryOriginBinding,
  MemoryEntryOriginOperations,
} from "./memory-entry-origins-task.js";
import { markMemoryForgotten, purgeForgottenMemory } from "./memory-forget-kernel.js";
import { ensureMemorySessionTombstones } from "./memory-session-tombstones.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

/** The existing agent executor owns this connection and its native lifetime. */
export function bindSqliteWorkerBackend(
  input: MemoryEntryOriginBinding,
  context: { database: DatabaseSync; admit(stage: "transaction" | "commit"): void },
) {
  const db = context.database;
  const admission = {
    onBegin: () => context.admit("transaction"),
    withCommit: (commit: () => void) => {
      context.admit("commit");
      commit();
    },
  };
  const transact = <T>(run: () => T): T =>
    runSqliteImmediateTransactionSync(
      db,
      () => {
        admission.onBegin();
        return run();
      },
      { withCommit: admission.withCommit },
    );
  if (input.kind === "forget") {
    if (input.extensionPath) {
      try {
        loadSqliteVecExtensionFromPath(db, input.extensionPath);
      } catch (error) {
        throw new Error(
          `memory forget cannot purge vector index: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    if (input.prepareTombstones && !tableExists(db, "memory_session_tombstones")) {
      withSqlitePostCommitPublications(db, () => transact(() => ensureMemorySessionTombstones(db)));
    }
  } else if (input.kind === "origin" && !tableExists(db, "memory_entry_origins")) {
    // A rejected origin batch must not undo the original additive schema preparation.
    withSqlitePostCommitPublications(db, () => transact(() => ensureMemoryEntryOriginsSchema(db)));
  }
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Memory origin worker binding is closed");
      }
      if (command.type === "record") {
        return transact(() => recordMemoryEntryOriginsInDatabase(db, command.input));
      }
      if (command.type === "reserve") {
        if (!tableExists(db, "memory_entry_origins")) {
          return [];
        }
        return transact(() => {
          const { agentId, operations } = command.input;
          const origins = readMemoryEntryOriginsInDatabase(db, {
            agentId,
            entryKeys: [...new Set(operations.flatMap((operation) => operation.parentKeys))],
          });
          return operations.flatMap(({ entryKey, parentKeys }) => {
            const parents = new Set(parentKeys);
            const selected = origins.filter((origin) => parents.has(origin.entryKey));
            const added = selected.length
              ? recordMemoryEntryOriginsInDatabase(db, {
                  agentId,
                  entryKey,
                  origins: selected,
                })
              : [];
            return added.length
              ? [
                  {
                    agentId,
                    entryKeys: [entryKey],
                    sessionIds: added.map((origin) => origin.sessionId),
                  },
                ]
              : [];
          });
        });
      }
      if (command.type === "prune") {
        if (!tableExists(db, "memory_entry_origins")) {
          return 0;
        }
        return transact(() => {
          const indexed = new Set(
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<{ memory_index_chunks: { text: string; source: string } }>(db)
                .selectFrom("memory_index_chunks")
                .select("text")
                .where("source", "=", "memory")
                .where("text", "like", "%openclaw-memory-promotion:%"),
            ).rows.flatMap(({ text }) => extractPromotionKeys(text)),
          );
          return deleteMemoryEntryOriginsInDatabase(db, {
            agentId: command.input.agentId,
            entryKeys: command.input.entryKeys.filter((key) => !indexed.has(key)),
          });
        });
      }
      if (command.type === "delete") {
        return deleteMemoryEntryOriginsInDatabase(db, command.input, admission);
      }
      return transact(() =>
        command.type === "forget.mark"
          ? markMemoryForgotten(db, command.input)
          : purgeForgottenMemory(db, command.input),
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Memory origin operation left an unsettled native connection");
      }
    },
    close() {
      closed = true;
    },
  } satisfies SqliteWorkerBackend<MemoryEntryOriginOperations>;
}
