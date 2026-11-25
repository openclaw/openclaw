import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { TEAM_REPORTS_POSTGRES_SCHEMA_SQL } from "./store-postgres-schema.js";
import { TEAM_REPORTS_SCHEMA_SQL, TEAM_REPORTS_SCHEMA_VERSION } from "./store-schema.js";

export const teamReportsEngineSchema: StoreSchema = {
  id: "team-reports",
  version: TEAM_REPORTS_SCHEMA_VERSION,
  sqlite: TEAM_REPORTS_SCHEMA_SQL,
  postgres: TEAM_REPORTS_POSTGRES_SCHEMA_SQL,
  postgresMigrations: [
    {
      version: 2,
      fromSchema: { postgres: withLegacyPostgresIndexOrdering(TEAM_REPORTS_POSTGRES_SCHEMA_SQL) },
      schema: { postgres: TEAM_REPORTS_POSTGRES_SCHEMA_SQL },
      sql: `${postgresIndexOrderingMigration(TEAM_REPORTS_POSTGRES_SCHEMA_SQL)}
        INSERT INTO team_reports_schema_migrations (id, applied_at)
        VALUES ('schema-2', CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS bigint));`,
    },
  ],
};
