import fs from "node:fs";

export const TEAM_REPORTS_POSTGRES_SCHEMA_SQL = fs.readFileSync(
  new URL("./team-reports-schema.postgres.sql", import.meta.url),
  "utf8",
);
