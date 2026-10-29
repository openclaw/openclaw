import fs from "node:fs";

export const LOGBOOK_POSTGRES_SCHEMA_SQL = fs.readFileSync(
  new URL("./logbook-schema.postgres.sql", import.meta.url),
  "utf8",
);
