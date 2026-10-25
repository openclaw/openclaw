import fs from "node:fs";
import path from "node:path";
import {
  openEngineStore,
  postgresIndexOrderingMigration,
  withEngineStoreAdmission,
  withLegacyPostgresIndexOrdering,
  type DatabaseEngineInput,
  type EngineConnection,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  admitSqliteSchema,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getAdmittedSqliteSchemaFacts,
  getNodeSqliteKysely,
  getSqliteDatabaseAdmission,
  openNodeSqliteDatabase,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
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

const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "teamReports.schema",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export function openTeamReportsConnection(dbPath: string, input?: DatabaseEngineInput) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dbPath), 0o700);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", 0o600));
  }
  const anchor = openNodeSqliteDatabase(dbPath);
  let selected: EngineConnection | undefined;
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  const close = () => {
    try {
      try {
        if (selected && selected !== anchor) {
          selected.close();
        }
      } finally {
        maintenance?.close();
      }
    } finally {
      anchor.close();
    }
  };
  try {
    enableNodeSqliteKyselyStatementCache(anchor);
    selected = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor,
        input,
        schema: teamReportsEngineSchema,
        admitPostgres: (db, fresh) => {
          if (fresh) {
            db.prepare(
              "INSERT INTO team_reports_schema_migrations (id, applied_at) VALUES (?, ?)",
            ).run(`schema-${TEAM_REPORTS_SCHEMA_VERSION}`, Date.now());
          }
        },
        inspectSqlite: () => {
          admitSqliteSchema(anchor);
          const facts = getAdmittedSqliteSchemaFacts(anchor);
          if (!facts) {
            throw new Error("Team Reports SQLite catalog admission is unavailable");
          }
          return {
            hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
            hasExistingData:
              [...facts.tables].some(
                (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
              ) ||
              facts.views.size > 0 ||
              facts.triggers.size > 0,
          };
        },
        prepareAnchor: () => {
          maintenance = configureSqliteConnectionPragmas(anchor, {
            busyTimeoutMs: 5000,
            checkpointIntervalMs: 0,
            databaseLabel: "team-reports database",
            databasePath: dbPath,
            foreignKeys: true,
            synchronous: "NORMAL",
          });
        },
        openSqlite: () => {
          if (getSqliteDatabaseAdmission(anchor, schemaAdmission)) {
            return;
          }
          anchor.exec(TEAM_REPORTS_SCHEMA_SQL);
          const query = getNodeSqliteKysely<{
            team_reports_schema_migrations: { id: string; applied_at: number };
          }>(anchor);
          const migration = executeSqliteQueryTakeFirstSync(
            anchor,
            query
              .selectFrom("team_reports_schema_migrations")
              .select("id")
              .where("id", "=", `schema-${TEAM_REPORTS_SCHEMA_VERSION}`),
          );
          if (!migration) {
            migrateSqliteSchemaToStrict(anchor, TEAM_REPORTS_SCHEMA_SQL, {
              databaseLabel: "team-reports database",
            });
            executeSqliteQuerySync(
              anchor,
              query
                .insertInto("team_reports_schema_migrations")
                .values({ id: `schema-${TEAM_REPORTS_SCHEMA_VERSION}`, applied_at: Date.now() })
                .onConflict((conflict) => conflict.column("id").doNothing()),
            );
          }
          publishSqliteDatabaseAdmission(anchor, schemaAdmission, true);
        },
      }),
    );
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return { db: selected, close };
  } catch (error) {
    close();
    throw error;
  }
}
