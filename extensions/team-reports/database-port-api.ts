import type { DatabaseSync } from "node:sqlite";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { TEAM_REPORTS_POSTGRES_SCHEMA_SQL } from "./src/store-postgres-schema.js";
import { TEAM_REPORTS_SCHEMA_VERSION } from "./src/store-schema.js";
import { openTeamReportsDatabase } from "./src/store.worker.js";

export const teamReportsDatabasePortApi = {
  postgres: TEAM_REPORTS_POSTGRES_SCHEMA_SQL,
  inspectSqliteSource(db: DatabaseSync) {
    admitSqliteSchema(db);
    if ((getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0) > TEAM_REPORTS_SCHEMA_VERSION) {
      throw new Error(
        `Team Reports requires SQLite schema version at most ${TEAM_REPORTS_SCHEMA_VERSION}`,
      );
    }
    const rows = db.prepare("SELECT id FROM team_reports_schema_migrations").all();
    let version = 0;
    for (const row of rows) {
      const match = typeof row.id === "string" && /^schema-([1-9][0-9]*)$/.exec(row.id);
      if (!match || Number(match[1]) > TEAM_REPORTS_SCHEMA_VERSION) {
        throw new Error(
          `Unknown Team Reports schema migration; required schema ${TEAM_REPORTS_SCHEMA_VERSION}`,
        );
      }
      version = Math.max(version, Number(match[1]));
    }
    return {
      version,
      migrationRequired: version < TEAM_REPORTS_SCHEMA_VERSION,
      pendingColumns: {},
    };
  },
  admit(file: string, input?: Parameters<typeof openTeamReportsDatabase>[1]) {
    openTeamReportsDatabase(file, input).close();
  },
};
