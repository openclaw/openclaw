import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

function listAgentIds(config: OpenClawConfig): string[] {
  const ids = new Set<string>(["main"]);
  if (isRecord(config.agents?.entries)) {
    for (const agentId of Object.keys(config.agents.entries)) {
      if (agentId.trim()) {
        ids.add(agentId.trim());
      }
    }
  }
  for (const agent of config.agents?.list ?? []) {
    if (typeof agent.id === "string" && agent.id.trim()) {
      ids.add(agent.id.trim());
    }
  }
  return [...ids];
}

function listCandidateStorePaths(params: {
  config: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0]["config"];
  env: NodeJS.ProcessEnv;
}): string[] {
  const paths = new Set<string>();
  for (const agentId of listAgentIds(params.config)) {
    paths.add(resolveStorePath(params.config.session?.store, { agentId, env: params.env }));
  }
  return [...paths];
}

async function hasRetiredSource(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hasRetiredLearnings(
  params: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
): Promise<boolean> {
  for (const storePath of listCandidateStorePaths(params)) {
    try {
      if (
        (await fs.stat(storePath)).isDirectory() &&
        (await fs.readdir(storePath)).some((name) => name.endsWith(".learnings.json"))
      ) {
        return true;
      }
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

function retiredJsonMigration(
  name: string,
  label: string,
  hasSource: (
    params: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
  ) => Promise<boolean>,
): PluginDoctorStateMigration {
  const guidance =
    `Microsoft Teams ${label} JSON state predates June 2026. ` +
    'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", then upgrade to latest. ' +
    "The legacy source was left untouched.";
  return {
    id: `msteams-${name}-json-to-plugin-state`,
    label: `Microsoft Teams ${label}`,
    async detectLegacyState(params) {
      return (await hasSource(params)) ? { preview: [guidance] } : null;
    },
    async migrateLegacyState(params) {
      return { changes: [], warnings: (await hasSource(params)) ? [guidance] : [] };
    },
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  retiredJsonMigration("conversations", "conversations", (params) =>
    hasRetiredSource(path.join(params.stateDir, "msteams-conversations.json")),
  ),
  retiredJsonMigration("polls", "polls", (params) =>
    hasRetiredSource(path.join(params.stateDir, "msteams-polls.json")),
  ),
  retiredJsonMigration("sso-tokens", "SSO tokens", (params) =>
    hasRetiredSource(path.join(params.stateDir, "msteams-sso-tokens.json")),
  ),
  {
    id: "msteams-delegated-token-json-to-plugin-state",
    label: "Microsoft Teams delegated OAuth token",
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
        label: `${MSTEAMS_PLUGIN_ID} delegated OAuth token`,
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
  retiredJsonMigration("feedback-learnings", "feedback learnings", hasRetiredLearnings),
];
