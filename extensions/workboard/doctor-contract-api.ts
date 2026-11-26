import fs from "node:fs";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const databasePath = (stateDir: string) =>
  path.join(stateDir, "plugins/workboard/workboard.sqlite");
const cardChildren =
  /^workboard_(?:card_(?:artifacts|attachments|attempts|comments|diagnostics|events|labels|links|notifications|proof)|worker_(?:logs|protocol))$/u;

async function checkCardOrphans(stateDir: string, repair: boolean) {
  const file = databasePath(stateDir);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
    return null;
  }
  const sqlite = await import("openclaw/plugin-sdk/sqlite-worker-runtime");
  const location = repair ? sqlite.resolveExistingSqliteFileUri(file) : file;
  using db = sqlite.openNodeSqliteDatabase(location, {
    readOnly: !repair,
    enableForeignKeyConstraints: false,
  });
  const check = db.prepare('SELECT DISTINCT "table", parent FROM pragma_foreign_key_check');
  const tables = check.all().map(({ table, parent }) => {
    if (typeof table === "string" && cardChildren.test(table) && parent === "workboard_cards") {
      return table;
    }
    throw new Error("Workboard orphan repair refused unrelated foreign-key violations.");
  });
  if (!tables.length || !repair) {
    return tables.length ? "Workboard has orphaned card rows." : null;
  }
  const { backupDoctorSqliteRepair } = await import("openclaw/plugin-sdk/doctor-repair-runtime");
  const backup = await backupDoctorSqliteRepair(file, "workboard-card-orphans");
  sqlite.runSqliteImmediateTransactionSync(db, () => {
    for (const table of tables) {
      db.exec(`DELETE FROM "${table}" WHERE card_id NOT IN (SELECT id FROM workboard_cards)`);
    }
    if (check.get()) {
      throw new Error(`Workboard still has foreign-key violations; retained backup: ${backup}`);
    }
  });
  return `Repaired orphaned Workboard card rows; backup: ${backup}`;
}

const RECOVERY =
  "Workboard has retired pre-July 2026 plugin-state KV data. Install OpenClaw 2026.9.7 and run openclaw doctor --fix before upgrading; the retained legacy rows have not been changed.";

async function detectRetiredState(
  params: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
) {
  const env = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  for (const [namespace, maxEntries] of [
    ["workboard.cards", 2000],
    ["workboard.boards", 200],
    ["workboard.notify", 2000],
    ["workboard.attachments", 42_000],
  ] as const) {
    const store = params.context.openPluginStateKeyedStore<unknown>({
      namespace,
      maxEntries,
      env,
    });
    if ((store.count ? await store.count() : (await store.entries()).length) > 0) {
      return { preview: [RECOVERY] };
    }
  }
  return null;
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "workboard-28-kv-to-sqlite",
    label: "Workboard .28 plugin-state KV",
    // This retired-state check leaves every legacy row unchanged.
    collectBackupResources: () => [],
    detectLegacyState: detectRetiredState,
    async migrateLegacyState(params) {
      return { changes: [], warnings: (await detectRetiredState(params))?.preview ?? [] };
    },
  },
  {
    id: "workboard-card-orphans",
    label: "Workboard orphaned card rows",
    doctorOnly: true,
    collectBackupResources: ({ stateDir }) => [{ kind: "sqlite", path: databasePath(stateDir) }],
    async detectLegacyState({ stateDir }) {
      const preview = await checkCardOrphans(stateDir, false);
      return preview ? { preview: [preview] } : null;
    },
    async migrateLegacyState({ stateDir }) {
      const change = await checkCardOrphans(stateDir, true);
      return { changes: change ? [change] : [], warnings: [] };
    },
  },
];
