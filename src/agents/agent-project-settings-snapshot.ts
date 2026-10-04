/** Builds embedded-agent settings snapshots from global, bundle, and project settings. */
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readBundleJsonObject } from "../plugins/bundle-config-shared.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "../plugins/config-policy.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import type { SettingsManager } from "./sessions/index.js";

const log = createSubsystemLogger("embedded-agent-settings");

const DEFAULT_EMBEDDED_AGENT_PROJECT_SETTINGS_POLICY = "sanitize";
const SANITIZED_PROJECT_AGENT_KEYS = ["shellPath", "shellCommandPrefix"] as const;

type EmbeddedAgentProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";

type AgentSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]> & {
  mcpServers?: Record<string, BundleMcpServerConfig>;
};

function sanitizeAgentSettingsSnapshot(settings: AgentSettingsSnapshot): AgentSettingsSnapshot {
  const sanitized = { ...settings };
  // Never allow plugin or workspace-local settings to override shell execution behavior.
  for (const key of SANITIZED_PROJECT_AGENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

/** Merge enabled bundle settings for one embedded-agent workspace. */
export function loadEnabledBundleAgentSettingsSnapshot(params: {
  cwd: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): AgentSettingsSnapshot {
  const workspaceDir = params.cwd.trim();
  if (!workspaceDir) {
    return {};
  }
  const config = params.cfg ?? {};
  const env = params.env ?? process.env;
  const providedSnapshot = params.pluginMetadataSnapshot;
  const metadataSnapshot =
    providedSnapshot ??
    loadPluginMetadataSnapshot({
      workspaceDir,
      config,
      env,
    });
  return withPluginCache(getPluginMetadataSnapshotCache(metadataSnapshot), () => {
    const { plugins } = metadataSnapshot.manifestRegistry;
    if (plugins.length === 0) {
      return {};
    }

    const normalizedPlugins = normalizePluginsConfigWithResolver(
      config.plugins,
      metadataSnapshot.normalizePluginId,
    );
    let snapshot: AgentSettingsSnapshot = {};

    for (const record of plugins) {
      const settingsFiles = record.settingsFiles ?? [];
      if (record.format !== "bundle" || settingsFiles.length === 0) {
        continue;
      }
      const activationState = resolvePolicyPluginActivationState({
        id: record.id,
        origin: record.origin,
        channelIds: record.channels,
        config: normalizedPlugins,
        rootConfig: config,
      });
      if (!activationState.activated) {
        continue;
      }
      for (const relativePath of settingsFiles) {
        const absolutePath = path.join(record.rootDir, relativePath);
        const result = readBundleJsonObject({
          rootDir: record.rootDir,
          relativePath,
          // Unsafe paths skip the bundle rather than weaken the plugin root boundary.
          allowMissing: false,
        });
        if (!result.ok) {
          const message =
            result.reason === "open" ? "skipping unsafe bundle settings file" : result.error;
          log.warn(`${message}: ${absolutePath}`);
          continue;
        }
        snapshot = applyMergePatch(
          snapshot,
          sanitizeAgentSettingsSnapshot(result.raw as AgentSettingsSnapshot),
        ) as AgentSettingsSnapshot;
      }
    }

    const embeddedAgentMcp = loadEmbeddedAgentMcpConfig({
      workspaceDir,
      cfg: config,
      manifestRegistry: metadataSnapshot.manifestRegistry,
    });
    for (const diagnostic of embeddedAgentMcp.diagnostics) {
      log.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
    if (Object.keys(embeddedAgentMcp.mcpServers).length > 0) {
      snapshot = applyMergePatch(snapshot, {
        mcpServers: embeddedAgentMcp.mcpServers,
      }) as AgentSettingsSnapshot;
    }

    return snapshot;
  });
}

/** Resolves the configured project-settings trust policy for embedded agents. */
export function resolveEmbeddedAgentProjectSettingsPolicy(
  cfg?: OpenClawConfig,
): EmbeddedAgentProjectSettingsPolicy {
  const raw = cfg?.agents?.defaults?.embeddedAgent?.projectSettingsPolicy;
  if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
    return raw;
  }
  return DEFAULT_EMBEDDED_AGENT_PROJECT_SETTINGS_POLICY;
}

/** Merges global, plugin, and project settings according to the selected trust policy. */
export function buildEmbeddedAgentSettingsSnapshot(params: {
  globalSettings: AgentSettingsSnapshot;
  pluginSettings?: AgentSettingsSnapshot;
  projectSettings: AgentSettingsSnapshot;
  policy: EmbeddedAgentProjectSettingsPolicy;
}): AgentSettingsSnapshot {
  const effectiveProjectSettings =
    params.policy === "ignore"
      ? {}
      : params.policy === "sanitize"
        ? sanitizeAgentSettingsSnapshot(params.projectSettings)
        : params.projectSettings;
  const withPluginSettings = applyMergePatch(
    params.globalSettings,
    sanitizeAgentSettingsSnapshot(params.pluginSettings ?? {}),
  ) as AgentSettingsSnapshot;
  return applyMergePatch(withPluginSettings, effectiveProjectSettings) as AgentSettingsSnapshot;
}
