import type { DatabaseSync } from "node:sqlite";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { TEAM_REPORTS_POSTGRES_SCHEMA_SQL } from "./src/store-postgres-schema.js";
import { openTeamReportsDatabase } from "./src/store.worker.js";

export const teamReportsDatabasePortApi = {
  postgres: TEAM_REPORTS_POSTGRES_SCHEMA_SQL,
  inspectSqliteSource(db: DatabaseSync) {
    admitSqliteSchema(db);
    if ((getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0) > 1) {
      throw new Error("Team Reports requires SQLite schema version at most 1");
    }
    const rows = db.prepare("SELECT id FROM team_reports_schema_migrations").all();
    if (rows.some((row) => row.id !== "schema-1")) {
      throw new Error("Unknown Team Reports schema migration; required schema 1");
    }
    return { version: rows.length ? 1 : 0, migrationRequired: !rows.length, pendingColumns: {} };
  },
  admit(file: string, input?: Parameters<typeof openTeamReportsDatabase>[1]) {
    openTeamReportsDatabase(file, input).close();
  },
};
