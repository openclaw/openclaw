import fs from "node:fs/promises";
import path from "node:path";
import type { BundledChannelLegacyStateMigrationDetector } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
  DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
} from "../command-deploy-store.js";

export const detectDiscordCommandDeployCacheMigration: BundledChannelLegacyStateMigrationDetector =
  async ({ stateDir }) => {
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
  };
