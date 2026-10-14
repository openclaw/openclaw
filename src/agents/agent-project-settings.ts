import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  buildEmbeddedAgentSettingsSnapshot,
  loadEnabledBundleAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
} from "./agent-project-settings-snapshot.js";
import { applyAgentCompactionSettingsFromConfig } from "./agent-settings.js";
import { SettingsManager } from "./sessions/index.js";

type PreparedSettings = {
  cwd: string;
  agentDir: string;
  configKey: string | undefined;
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  snapshot: ReturnType<typeof buildEmbeddedAgentSettingsSnapshot>;
};

const preparedSessionSettings = new Map<string, PreparedSettings>();
const MAX_PREPARED_SESSION_SETTINGS = 64;
registerPluginMetadataProcessMemoLifecycleClear(() => preparedSessionSettings.clear());

export function clearPreparedEmbeddedAgentSettings(sessionIds: Iterable<string | undefined>): void {
  for (const sessionId of sessionIds) {
    if (sessionId) {
      preparedSessionSettings.delete(sessionId);
    }
  }
}

export function createPreparedEmbeddedAgentSettingsManager(params: {
  sessionId: string;
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const configKey = params.cfg ? resolveRuntimeConfigCacheKey(params.cfg) : undefined;
  let prepared = preparedSessionSettings.get(params.sessionId);
  if (
    !prepared ||
    prepared.cwd !== params.cwd ||
    prepared.agentDir !== params.agentDir ||
    prepared.configKey !== configKey ||
    prepared.pluginMetadataSnapshot !== params.pluginMetadataSnapshot
  ) {
    const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
    prepared = {
      cwd: params.cwd,
      agentDir: params.agentDir,
      configKey,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      snapshot: freezeJsonSnapshot(
        buildEmbeddedAgentSettingsSnapshot({
          globalSettings: fileSettingsManager.getGlobalSettings(),
          pluginSettings: loadEnabledBundleAgentSettingsSnapshot(params),
          projectSettings: fileSettingsManager.getProjectSettings(),
          policy: resolveEmbeddedAgentProjectSettingsPolicy(params.cfg),
        }),
      ),
    };
  }
  preparedSessionSettings.delete(params.sessionId);
  preparedSessionSettings.set(params.sessionId, prepared);
  pruneMapToMaxSize(preparedSessionSettings, MAX_PREPARED_SESSION_SETTINGS);
  // File edits join the next session or explicit invalidation; attempt mutations
  // and model-dependent compaction settings never flow back into the shared snapshot.
  const settingsManager = SettingsManager.inMemory(prepared.snapshot);
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
    contextTokenBudget: params.contextTokenBudget,
  });
  // The embedded runner owns retries; session auto-retry could replay tool calls (#73781).
  settingsManager.setRetryEnabled(false);
  return settingsManager;
}
