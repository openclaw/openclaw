import type {
  EngineConnection,
  SearchSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { memoryStandingIntentSearchSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

/** PostgreSQL indexes canonical keywords directly; SQLite owns an external-content FTS table. */
export function standingIntentSearchSchema(db: EngineConnection): SearchSchema {
  return {
    text: {
      intents: isPostgresSqlConnection(db)
        ? memoryStandingIntentSearchSchema.text!.intents!
        : {
            table: "standing_intents_fts",
            alias: "fts",
            fields: ["trigger_keywords"],
            matchField: "trigger_keywords",
          },
    },
  };
}
