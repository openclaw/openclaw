import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  definePluginDoctorMigrationFromPlans,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
  DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
} from "../command-deploy-store.js";

async function retiredStateWarnings(stateDir: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const name of ["model-picker-preferences.json", "thread-bindings.json"]) {
    const sourcePath = path.join(stateDir, "discord", name);
    try {
      await fs.lstat(sourcePath);
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    warnings.push(
      `Preserved retired Discord JSON state at ${sourcePath}. Install OpenClaw 2026.9.5, run "openclaw doctor --fix", then upgrade to latest. See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.`,
    );
  }
  return warnings;
}

const commandDeployCacheMigration = definePluginDoctorMigrationFromPlans({
  id: "discord-legacy-state",
  label: "Discord legacy state",
  async resolvePlans({ stateDir }) {
    const sourcePath = path.join(stateDir, "discord", "command-deploy-cache.json");
    try {
      if (!(await fs.stat(sourcePath)).isFile()) {
        return [];
      }
    } catch {
      return [];
    }
    return [
      {
        kind: "plugin-state-import",
        label: "Discord command deployment cache",
        sourcePath,
        targetPath: `plugin state:${DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE}`,
        pluginId: "discord",
        namespace: DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
        maxEntries: DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
        scopeKey: "",
        cleanupSource: "remove",
        cleanupWhenEmpty: true,
        cleanupWarningDisposition: "recoverable",
        // July still wrote this rebuildable cache; reconcile hashes against Discord once.
        readEntries: () => [],
      },
    ];
  },
});

export const discordLegacyStateMigration: PluginDoctorStateMigration = {
  ...commandDeployCacheMigration,
  async detectLegacyState(input) {
    const retired = await retiredStateWarnings(input.stateDir);
    const cache = await commandDeployCacheMigration.detectLegacyState(input);
    const preview = [...(cache?.preview ?? []), ...retired];
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState(input) {
    const cache = await commandDeployCacheMigration.migrateLegacyState(input);
    const retired = await retiredStateWarnings(input.stateDir);
    if (retired.length === 0) {
      return cache;
    }
    return { changes: cache.changes, warnings: [...cache.warnings, ...retired] };
  },
};
