import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveDatabaseFamilyEngines,
  withDatabaseEngineSelection,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import pg from "pg";

export function postgresProductScope(name: string) {
  const configured = getEnvironmentData("openclaw.test.workboard.connection");
  const connection = typeof configured === "string" ? configured : undefined;
  const prefix = `${name}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const client = new pg.Client({ connectionString: connection });
  return {
    connection,
    connect: () => client.connect(),
    select: <T>(run: () => T, config: OpenClawConfig = { database: { engine: "postgres" } }) =>
      withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines(config),
          postgres: { connection: connection!, schemaPrefix: prefix },
        },
        run,
      ),
    async close() {
      try {
        const schemas = await client.query<{ nspname: string }>(
          "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
          [prefix.length + 1, `${prefix}_`],
        );
        for (const { nspname } of schemas.rows) {
          await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    },
  };
}
