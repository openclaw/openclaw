import fs from "node:fs";

export const WORKBOARD_POSTGRES_SCHEMA_SQL = fs.readFileSync(
  new URL("./workboard-schema.postgres.sql", import.meta.url),
  "utf8",
);
