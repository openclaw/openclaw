import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { applyPiCompactionSettingsFromConfig } from "./pi-settings.js";

export const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
export const SANITIZED_PROJECT_PI_KEYS = ["shellPath", "shellCommandPrefix"] as const;

export type EmbeddedPiProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";

type PiSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]>;

function sanitizeProjectSettings(settings: PiSettingsSnapshot): PiSettingsSnapshot {
  const sanitized = { ...settings };
  // Never allow workspace-local settings to override shell execution behavior.
  for (const key of SANITIZED_PROJECT_PI_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function resolveEmbeddedPiProjectSettingsPolicy(
  cfg?: OpenClawConfig,
): EmbeddedPiProjectSettingsPolicy {
  const raw = cfg?.agents?.defaults?.embeddedPi?.projectSettingsPolicy;
  if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
    return raw;
  }
  return DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY;
}

export function buildEmbeddedPiSettingsSnapshot(params: {
  globalSettings: PiSettingsSnapshot;
  projectSettings: PiSettingsSnapshot;
  policy: EmbeddedPiProjectSettingsPolicy;
}): PiSettingsSnapshot {
  const effectiveProjectSettings =
    params.policy === "ignore"
      ? {}
      : params.policy === "sanitize"
        ? sanitizeProjectSettings(params.projectSettings)
        : params.projectSettings;
  return applyMergePatch(params.globalSettings, effectiveProjectSettings) as PiSettingsSnapshot;
}

export function createEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  const policy = resolveEmbeddedPiProjectSettingsPolicy(params.cfg);
  if (policy === "trusted") {
    return fileSettingsManager;
  }
  const settings = buildEmbeddedPiSettingsSnapshot({
    globalSettings: fileSettingsManager.getGlobalSettings(),
    projectSettings: fileSettingsManager.getProjectSettings(),
    policy,
  });
  return SettingsManager.inMemory(settings);
}

export function createPreparedEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: OpenClawConfig;
}): SettingsManager {
  const settingsManager = createEmbeddedPiSettingsManager(params);
  applyPiCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
  });
  return settingsManager;
}
