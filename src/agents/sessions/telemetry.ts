import { isTruthyEnvValue } from "../../infra/env.js";
/**
 * Environment overrides win over persisted settings for CI and packaged launcher control.
 */
import type { SettingsManager } from "./settings-manager.js";

export function isInstallTelemetryEnabled(
  settingsManager: SettingsManager,
  telemetryEnv: string | undefined = process.env.OPENCLAW_TELEMETRY,
): boolean {
  return telemetryEnv !== undefined
    ? isTruthyEnvValue(telemetryEnv)
    : settingsManager.getEnableInstallTelemetry();
}
