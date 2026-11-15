import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";

export const workboardEngineSchema: StoreSchema = {
  id: "workboard",
  version: SCHEMA_VERSION,
  sqlite: WORKBOARD_SCHEMA_SQL,
  postgres: WORKBOARD_POSTGRES_SCHEMA_SQL,
  postgresMigrations: [
    {
      version: 4,
      fromSchema: { postgres: withLegacyPostgresIndexOrdering(WORKBOARD_POSTGRES_SCHEMA_SQL) },
      schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_SQL },
      sql: postgresIndexOrderingMigration(WORKBOARD_POSTGRES_SCHEMA_SQL),
    },
  ],
};
