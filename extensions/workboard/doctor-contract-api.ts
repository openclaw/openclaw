import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

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
];
