import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { bindSqliteWorkerDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";

export type CleanupInspection = {
  inspect: {
    input: undefined;
    output: { pid: number; stages: string[]; paths: string[] };
  };
};

/** Observe the retained executor's own TEMP namespace without closing its connection. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  { database }: { database: EngineConnection },
) {
  if (!isPostgresSqlConnection(database)) {
    throw new Error("Cleanup inspection requires PostgreSQL");
  }
  return bindSqliteWorkerDatabase<CleanupInspection>(database, {
    execute() {
      return {
        pid: Number(database.prepare("SELECT pg_backend_pid() AS pid").get()!.pid),
        stages: database
          .prepare(
            "SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND starts_with(relname, 'memory_stage_') AND relkind = 'r' ORDER BY relname",
          )
          .all()
          .map((row) => String(row.relname)),
        paths: database
          .prepare("SELECT path FROM memory_index_sources ORDER BY path")
          .all()
          .map((row) => String(row.path)),
      };
    },
  });
}
