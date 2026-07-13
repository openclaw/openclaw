/**
 * Install telemetry switch.
 *
 * Persisted settings control the anonymous update ping.
 */
import type { SettingsManager } from "./settings-manager.js";

/** Resolves whether install telemetry is enabled from persisted settings. */
export function isInstallTelemetryEnabled(settingsManager: SettingsManager): boolean {
  return settingsManager.getEnableInstallTelemetry();
}
