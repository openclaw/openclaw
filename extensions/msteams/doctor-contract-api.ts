import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { stateFileArchiveDirectory, stateFileBackupResources } from "./doctor-backup-resources.js";
import {
  MSTEAMS_DELEGATED_TOKEN_KEY,
  MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME,
  MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
  MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
  normalizeMSTeamsDelegatedTokens,
} from "./src/delegated-state.js";
import type { MSTeamsDelegatedTokens } from "./src/oauth.shared.js";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

const MSTEAMS_PLUGIN_ID = "Microsoft Teams";

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "msteams-delegated-token-json-to-plugin-state",
    label: "Microsoft Teams delegated OAuth token",
    collectBackupResources: ({ stateDir }) =>
      stateFileBackupResources(stateDir, MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME),
    async detectLegacyState(params) {
      const filePath = path.join(params.stateDir, MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME);
      try {
        const stat = await fs.stat(filePath);
        return stat.isFile()
          ? {
              preview: [
                `- ${MSTEAMS_PLUGIN_ID} delegated OAuth token -> plugin state (${MSTEAMS_DELEGATED_TOKEN_NAMESPACE})`,
              ],
            }
          : null;
      } catch {
        return null;
      }
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = path.join(params.stateDir, MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME);
      let token: MSTeamsDelegatedTokens | null;
      try {
        token = normalizeMSTeamsDelegatedTokens(
          JSON.parse(await fs.readFile(filePath, "utf8")) as unknown,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { changes, warnings };
        }
        warnings.push(
          `Failed reading ${MSTEAMS_PLUGIN_ID} delegated OAuth token legacy source; left it in place`,
        );
        return { changes, warnings };
      }
      if (!token) {
        warnings.push(
          `Invalid ${MSTEAMS_PLUGIN_ID} delegated OAuth token legacy source; left it in place`,
        );
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<MSTeamsDelegatedTokens>({
        namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
        maxEntries: MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const existing = await store.lookup(MSTEAMS_DELEGATED_TOKEN_KEY);
      if (existing && JSON.stringify(existing) !== JSON.stringify(token)) {
        warnings.push(
          `Kept existing ${MSTEAMS_PLUGIN_ID} delegated OAuth token in plugin state; left differing legacy source in place`,
        );
        return { changes, warnings };
      }
      if (!existing) {
        try {
          await store.registerIfAbsent(MSTEAMS_DELEGATED_TOKEN_KEY, token);
        } catch (error) {
          warnings.push(
            `Failed importing ${MSTEAMS_PLUGIN_ID} delegated OAuth token: ${String(error)}; left legacy source in place`,
          );
          return { changes, warnings };
        }
      }
      const persisted = normalizeMSTeamsDelegatedTokens(
        await store.lookup(MSTEAMS_DELEGATED_TOKEN_KEY),
      );
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(token)) {
        warnings.push(
          `Failed verifying ${MSTEAMS_PLUGIN_ID} delegated OAuth token in plugin state; left legacy source in place`,
        );
        return { changes, warnings };
      }
      changes.push(`Migrated ${MSTEAMS_PLUGIN_ID} delegated OAuth token -> plugin state`);
      await archiveLegacyStateSource({
        filePath,
        archiveDirectory: stateFileArchiveDirectory(filePath),
        label: `${MSTEAMS_PLUGIN_ID} delegated OAuth token`,
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
];
