import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  buildEmbeddedPiSettingsSnapshot,
  loadEnabledBundlePiSettingsSnapshot,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings-snapshot.js";
import { applyPiCompactionSettingsFromConfig } from "./pi-settings.js";

function createEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  const policy = resolveEmbeddedPiProjectSettingsPolicy(params.cfg);
  const pluginSettings = loadEnabledBundlePiSettingsSnapshot({
    cwd: params.cwd,
    cfg: params.cfg,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  });
  const hasPluginSettings = Object.keys(pluginSettings).length > 0;
  if (policy === "trusted" && !hasPluginSettings) {
    return fileSettingsManager;
  }
  const settings = buildEmbeddedPiSettingsSnapshot({
    globalSettings: fileSettingsManager.getGlobalSettings(),
    pluginSettings,
    projectSettings: fileSettingsManager.getProjectSettings(),
    policy,
  });
  return SettingsManager.inMemory(settings);
}

function createRuntimeEmbeddedPiSettingsManager(settingsManager: SettingsManager): SettingsManager {
  return SettingsManager.inMemory(
    buildEmbeddedPiSettingsSnapshot({
      globalSettings: settingsManager.getGlobalSettings(),
      pluginSettings: {},
      projectSettings: settingsManager.getProjectSettings(),
      policy: "trusted",
    }),
  );
}

export function createPreparedEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Resolved context window budget so reserve-token floor can be capped for small models. */
  contextTokenBudget?: number;
}): SettingsManager {
  const settingsManager = createRuntimeEmbeddedPiSettingsManager(
    createEmbeddedPiSettingsManager(params),
  );
  applyPiCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
    contextTokenBudget: params.contextTokenBudget,
  });
  // Disable SDK auto-retry via in-memory override so we don't persist the
  // setting to disk (#73781). Build a flat snapshot from effective settings
  // (including compaction overrides applied above) and patch retry.enabled=false.
  const flat = {
    ...settingsManager.getGlobalSettings(),
    ...settingsManager.getProjectSettings(),
  };
  flat.retry = { ...flat.retry, enabled: false };
  // Preserve compaction overrides that were applied via applyOverrides above.
  flat.compaction = {
    ...flat.compaction,
    reserveTokens: settingsManager.getCompactionReserveTokens(),
    keepRecentTokens: settingsManager.getCompactionKeepRecentTokens(),
  };
  return SettingsManager.inMemory(flat);
}
