import {
  admitStoreSearch,
  type SearchSchema,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  DatabaseSearchCapabilityUnavailableError,
  isPostgresSqlConnection,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  bindSqliteWorkerDatabase,
  ensureOpenClawAgentStandingIntentsSchema,
  runSqliteImmediateTransactionSync,
  withSqlitePostCommitPublications,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  cancelStandingIntentInDatabase,
  createStandingIntentInDatabase,
  getStandingIntentLifecycleDeadline,
  hasNoActiveStandingIntents,
  invalidateStandingIntentLifecycle,
  listStandingIntentsInDatabase,
  maintainStandingIntentLifecycle,
  matchStandingIntentsInDatabase,
} from "./standing-intents-kernel.js";
import type { StandingIntentWorkerOperations } from "./standing-intents-model.js";
import { standingIntentSearchSchema } from "./standing-intents-search.js";

/** The canonical agent executor retains and closes this connection. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    database: EngineConnection;
    admit(stage: "transaction" | "commit"): void;
    admitSearchExtensions?: (definitions: Readonly<Record<string, SearchSchema>>) => void;
  },
): SqliteWorkerBackend<StandingIntentWorkerOperations> {
  const db = context.database;
  const transact = <T>(run: () => T): T => {
    try {
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          context.admit("transaction");
          return run();
        },
        {
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    } catch (error) {
      // A refused commit must not retain deadlines from its rolled-back transitions.
      invalidateStandingIntentLifecycle(db);
      throw error;
    }
  };
  let schemaPrepared = false;
  if (isPostgresSqlConnection(db)) {
    const definition = standingIntentSearchSchema(db);
    try {
      admitStoreSearch(db, definition);
    } catch (error) {
      if (
        !(error instanceof DatabaseSearchCapabilityUnavailableError) ||
        !context.admitSearchExtensions
      ) {
        throw error;
      }
      context.admitSearchExtensions({ "memory.standing-intents": definition });
      schemaPrepared = true;
    }
  } else {
    // First-use installation commits independently and consumes this request's grant pair.
    withSqlitePostCommitPublications(db, () =>
      ensureOpenClawAgentStandingIntentsSchema(db, (run) => {
        const result = transact(run);
        schemaPrepared = true;
        return result;
      }),
    );
  }
  return bindSqliteWorkerDatabase<StandingIntentWorkerOperations>(db, {
    execute(command) {
      if (schemaPrepared) {
        return { kind: "schema-prepared" };
      }
      const result = <T>(value: T) => ({
        kind: "result" as const,
        value,
        nextDueAt: getStandingIntentLifecycleDeadline(db),
      });
      // Absence survives until an owner write; there is no effect to transact or authorize.
      if (command.type === "match" && hasNoActiveStandingIntents(db)) {
        return result([]);
      }
      return transact<
        StandingIntentWorkerOperations[keyof StandingIntentWorkerOperations]["output"]
      >(() => {
        if (command.type === "create") {
          return result(createStandingIntentInDatabase(db, command.input));
        }
        if (command.type === "list") {
          return result(listStandingIntentsInDatabase(db, command.input));
        }
        if (command.type === "sweep") {
          return result(maintainStandingIntentLifecycle(db, command.input.nowMs ?? Date.now()));
        }
        if (command.type === "cancel") {
          return result(cancelStandingIntentInDatabase(db, command.input));
        }
        return result(matchStandingIntentsInDatabase(db, command.input));
      });
    },
  });
}
