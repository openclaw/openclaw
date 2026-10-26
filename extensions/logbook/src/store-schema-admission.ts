import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type DatabaseEngineInput,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  admitSqliteSchema,
  enableNodeSqliteKyselyStatementCache,
  getAdmittedSqliteSchemaFacts,
  getSqliteDatabaseAdmission,
  openNodeSqliteDatabase,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { logbookEngineSchema } from "./store-engine-schema.js";
import { LOGBOOK_SCHEMA_VERSION, SCHEMA } from "./store-schema.js";

export const LOGBOOK_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "logbook.schema",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

export function createLogbookDatabase(dbPath: string, input?: DatabaseEngineInput) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const anchor = openNodeSqliteDatabase(dbPath);
  let selected: EngineConnection | undefined;
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    // WAL/SHM sidecars inherit the main DB file's permissions.
    chmodSync(dbPath, 0o600);
    selected = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor,
        input,
        schema: logbookEngineSchema,
        inspectSqlite: () => {
          admitSqliteSchema(anchor);
          const facts = getAdmittedSqliteSchemaFacts(anchor);
          if (!facts) {
            throw new Error("Logbook SQLite catalog admission is unavailable");
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
            busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: "logbook",
            databasePath: dbPath,
            foreignKeys: true,
            synchronous: "NORMAL",
          });
        },
        openSqlite: () => {
          enableNodeSqliteKyselyStatementCache(anchor);
          if (getSqliteDatabaseAdmission(anchor, schemaAdmission)) {
            return;
          }
          const versionRow = anchor.prepare("PRAGMA user_version").get();
          const schemaVersion = Number(versionRow?.user_version ?? 0);
          if (schemaVersion > LOGBOOK_SCHEMA_VERSION) {
            throw new Error(
              `Logbook database uses newer schema version ${schemaVersion}; this build supports ${LOGBOOK_SCHEMA_VERSION}`,
            );
          }
          anchor.exec(SCHEMA);
          if (schemaVersion < LOGBOOK_SCHEMA_VERSION) {
            migrateSqliteSchemaToStrict(anchor, SCHEMA, { databaseLabel: dbPath });
            anchor.exec(`PRAGMA user_version = ${LOGBOOK_SCHEMA_VERSION};`);
          }
          publishSqliteDatabaseAdmission(anchor, schemaAdmission, true);
        },
      }),
    );
    return {
      db: selected,
      async close() {
        await maintenance?.stop();
        try {
          if (selected !== anchor) {
            selected?.close();
          }
        } finally {
          try {
            maintenance?.close();
          } finally {
            anchor.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      anchor.close();
    }
    throw error;
  }
}
