import type { DatabaseSync } from "node:sqlite";
import type { DatabaseEngineInput } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { createLogbookDatabase } from "./src/store-schema-admission.js";
import { LOGBOOK_SCHEMA_VERSION } from "./src/store-schema.js";

class LogbookPortSchemaError extends Error {}

export const logbookDatabasePortApi = {
  LogbookPortSchemaError,
  inspectLogbookPortSource(db: DatabaseSync) {
    admitSqliteSchema(db);
    const version = getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0;
    if (version > LOGBOOK_SCHEMA_VERSION) {
      throw new LogbookPortSchemaError(
        `schema version ${version}; required at most ${LOGBOOK_SCHEMA_VERSION}`,
      );
    }
    return { version, migrationRequired: version < LOGBOOK_SCHEMA_VERSION, pendingColumns: {} };
  },
  async admitLogbookPort(file: string, input?: DatabaseEngineInput) {
    await createLogbookDatabase(file, input).close();
  },
};
