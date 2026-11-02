import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  clearPreparedEmbeddedAgentSettings,
  prepareAgentSettingsSnapshot,
} from "./agent-project-settings-prepared.js";
import {
  buildEmbeddedAgentSettingsSnapshot,
  resolveEmbeddedAgentProjectSettingsPolicy,
  type AgentSettingsSnapshot,
} from "./agent-project-settings-snapshot.js";
import { applyAgentCompactionSettingsFromConfig } from "./agent-settings.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import { requireSupportedSettings, SettingsManager } from "./sessions/settings-manager.js";

export { clearPreparedEmbeddedAgentSettings } from "./agent-project-settings-prepared.js";
const log = createSubsystemLogger("embedded-agent-settings");

export function createPreparedEmbeddedAgentSettingsManager(params: {
  sessionId: string;
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const prepared = prepareAgentSettingsSnapshot(params);
  // Validate both original scopes, including ignored project settings, as before.
  // Native retry preparation must not inherit these embedded-only startup gates.
  try {
    requireSupportedSettings(prepared.globalSettings, "global");
    requireSupportedSettings(prepared.projectSettings, "project");
    if (!prepared.embeddedSnapshot) {
      let pluginSettings = prepared.pluginSettings;
      if (params.cwd.trim() && prepared.metadata.manifestRegistry.plugins.length > 0) {
        const mcp = withPluginCache(getPluginMetadataSnapshotCache(prepared.metadata), () =>
          loadEmbeddedAgentMcpConfig({
            workspaceDir: params.cwd.trim(),
            cfg: params.cfg ?? {},
            manifestRegistry: prepared.metadata.manifestRegistry,
          }),
        );
        for (const diagnostic of mcp.diagnostics) {
          log.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
        }
        if (Object.keys(mcp.mcpServers).length > 0) {
          const merged = applyMergePatch(pluginSettings, {
            mcpServers: mcp.mcpServers,
          });
          // SAFETY: The object patch only merges typed MCP servers into the settings record.
          pluginSettings = merged as AgentSettingsSnapshot;
        }
      }
      prepared.embeddedSnapshot = freezeJsonSnapshot(
        buildEmbeddedAgentSettingsSnapshot({
          globalSettings: prepared.globalSettings,
          pluginSettings,
          projectSettings: prepared.projectSettings,
          policy: resolveEmbeddedAgentProjectSettingsPolicy(params.cfg),
        }),
      );
    }
  } catch (error) {
    // A failed preparation never pinned invalid file contents before this split.
    clearPreparedEmbeddedAgentSettings([params.sessionId]);
    throw error;
  }
  // File edits join the next session or explicit invalidation; attempt mutations
  // and model-dependent compaction settings never flow back into the shared snapshot.
  const settingsManager = SettingsManager.inMemory(prepared.embeddedSnapshot);
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
    contextTokenBudget: params.contextTokenBudget,
  });
  // The embedded runner owns retries; session auto-retry could replay tool calls (#73781).
  settingsManager.setRetryEnabled(false);
  return settingsManager;
}
