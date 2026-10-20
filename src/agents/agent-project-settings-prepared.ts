import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  buildEmbeddedAgentSettingsSnapshot,
  loadEnabledBundleAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
  type AgentSettingsSnapshot,
} from "./agent-project-settings-snapshot.js";
import { FileSettingsStorage, readSettingsScope } from "./sessions/settings-storage.js";

type PreparedSettingsParams = {
  sessionId: string;
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type PreparedSettings = {
  cwd: string;
  agentDir: string;
  configKey: string | undefined;
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  metadata: PluginMetadataSnapshot;
  globalSettings: AgentSettingsSnapshot;
  projectSettings: AgentSettingsSnapshot;
  pluginSettings: AgentSettingsSnapshot;
  snapshot: AgentSettingsSnapshot;
  embeddedSnapshot?: AgentSettingsSnapshot;
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

/** Share immutable input facts; embedded validation and MCP setup remain at their owner. */
export function prepareAgentSettingsSnapshot(params: PreparedSettingsParams): PreparedSettings {
  const configKey = params.cfg ? resolveRuntimeConfigCacheKey(params.cfg) : undefined;
  let prepared = preparedSessionSettings.get(params.sessionId);
  if (
    !prepared ||
    prepared.cwd !== params.cwd ||
    prepared.agentDir !== params.agentDir ||
    prepared.configKey !== configKey ||
    prepared.pluginMetadataSnapshot !== params.pluginMetadataSnapshot
  ) {
    const storage = new FileSettingsStorage(params.cwd, params.agentDir);
    const globalSettings = freezeJsonSnapshot(readSettingsScope(storage, "global").settings);
    const projectSettings = freezeJsonSnapshot(readSettingsScope(storage, "project").settings);
    const metadata =
      params.pluginMetadataSnapshot ??
      loadPluginMetadataSnapshot({ workspaceDir: params.cwd, config: params.cfg ?? {} });
    const pluginSettings = freezeJsonSnapshot(
      loadEnabledBundleAgentSettingsSnapshot({ ...params, pluginMetadataSnapshot: metadata }),
    );
    prepared = {
      cwd: params.cwd,
      agentDir: params.agentDir,
      configKey,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      metadata,
      globalSettings,
      projectSettings,
      pluginSettings,
      snapshot: freezeJsonSnapshot(
        buildEmbeddedAgentSettingsSnapshot({
          globalSettings,
          pluginSettings,
          projectSettings,
          policy: resolveEmbeddedAgentProjectSettingsPolicy(params.cfg),
        }),
      ),
    };
  }
  preparedSessionSettings.delete(params.sessionId);
  preparedSessionSettings.set(params.sessionId, prepared);
  pruneMapToMaxSize(preparedSessionSettings, MAX_PREPARED_SESSION_SETTINGS);
  return prepared;
}

/** Absence must preserve a harness's shipped result budget and the host defaults. */
export function prepareAgentProviderRetryCount(params: PreparedSettingsParams): number | undefined {
  return prepareAgentSettingsSnapshot(params).snapshot.retry?.provider?.maxRetries;
}
