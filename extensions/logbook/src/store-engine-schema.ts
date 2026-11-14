import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { LOGBOOK_POSTGRES_SCHEMA_SQL } from "./logbook-postgres-schema.js";
import { LOGBOOK_SCHEMA_VERSION, SCHEMA } from "./store-schema.js";

const logbookPostgresV2Sql = withLegacyPostgresIndexOrdering(
  LOGBOOK_POSTGRES_SCHEMA_SQL,
  "schema-nullability",
);

export const logbookEngineSchema: StoreSchema = {
  id: "logbook",
  version: LOGBOOK_SCHEMA_VERSION,
  sqlite: SCHEMA,
  postgres: LOGBOOK_POSTGRES_SCHEMA_SQL,
  postgresMigrations: [
    {
      version: 2,
      fromSchema: { postgres: withLegacyPostgresIndexOrdering(logbookPostgresV2Sql) },
      schema: { postgres: logbookPostgresV2Sql },
      sql: postgresIndexOrderingMigration(logbookPostgresV2Sql),
    },
    {
      version: 3,
      fromSchema: { postgres: logbookPostgresV2Sql },
      schema: { postgres: LOGBOOK_POSTGRES_SCHEMA_SQL },
      sql: postgresIndexOrderingMigration(LOGBOOK_POSTGRES_SCHEMA_SQL, "schema-nullability"),
    },
  ],
};
