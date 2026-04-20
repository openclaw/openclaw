/**
 * Startup greeting marker.
 * 启动问候标记。
 *
 * Distinguishes first-launch / version-upgrade / normal-restart so the
 * gateway can greet the upgrade-triggering user exactly once per version
 * change. File names are keyed by (accountId, appId); the legacy global
 * `startup-marker.json` is migrated automatically.
 */

import * as fs from "node:fs";
import { getPluginVersion } from "../commands/slash-commands-impl.js";
import { getLegacyStartupMarkerFile, getStartupMarkerFile } from "../utils/data-paths.js";

const STARTUP_GREETING_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export function getFirstLaunchGreetingText(): string {
  return `Haha, my 'soul' is online — I'm here whenever you need me.`;
}

export function getUpgradeGreetingText(version: string): string {
  return `🎉 QQBot plugin updated to v${version}. Ready when you are.`;
}

export type StartupMarkerData = {
  version?: string;
  startedAt?: string;
  greetedAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  lastFailureVersion?: string;
};

/**
 * Read the startup marker for (accountId, appId).
 *
 * Strategy: new path first → legacy global `startup-marker.json` →
 * auto-migrate legacy contents to the new path.
 */
export function readStartupMarker(accountId: string, appId: string): StartupMarkerData {
  try {
    const file = getStartupMarkerFile(accountId, appId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as StartupMarkerData;
      return data || {};
    }
    const legacy = getLegacyStartupMarkerFile();
    if (fs.existsSync(legacy)) {
      const data = JSON.parse(fs.readFileSync(legacy, "utf8")) as StartupMarkerData;
      if (data) {
        writeStartupMarker(accountId, appId, data);
        return data;
      }
    }
  } catch {
    /* corrupt or missing — treat as empty */
  }
  return {};
}

export function writeStartupMarker(
  accountId: string,
  appId: string,
  data: StartupMarkerData,
): void {
  try {
    fs.writeFileSync(getStartupMarkerFile(accountId, appId), `${JSON.stringify(data)}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Decide whether to send a startup greeting:
 * - First launch (no marker) → "soul online"
 * - Version change → "updated to vX.Y.Z"
 * - Same version → skip
 * - Same version with recent failure → skip during cooldown
 */
export function getStartupGreetingPlan(
  accountId: string,
  appId: string,
): { shouldSend: boolean; greeting?: string; version: string; reason?: string } {
  const currentVersion = getPluginVersion();
  const marker = readStartupMarker(accountId, appId);

  if (marker.version === currentVersion) {
    return { shouldSend: false, version: currentVersion, reason: "same-version" };
  }

  if (marker.lastFailureVersion === currentVersion && marker.lastFailureAt) {
    const lastFailureAtMs = new Date(marker.lastFailureAt).getTime();
    if (
      !Number.isNaN(lastFailureAtMs) &&
      Date.now() - lastFailureAtMs < STARTUP_GREETING_RETRY_COOLDOWN_MS
    ) {
      return { shouldSend: false, version: currentVersion, reason: "cooldown" };
    }
  }

  const isFirstLaunch = !marker.version;
  const greeting = isFirstLaunch
    ? getFirstLaunchGreetingText()
    : getUpgradeGreetingText(currentVersion);

  return { shouldSend: true, greeting, version: currentVersion };
}

export function markStartupGreetingSent(accountId: string, appId: string, version: string): void {
  writeStartupMarker(accountId, appId, {
    version,
    startedAt: new Date().toISOString(),
    greetedAt: new Date().toISOString(),
  });
}

export function markStartupGreetingFailed(
  accountId: string,
  appId: string,
  version: string,
  reason: string,
): void {
  const marker = readStartupMarker(accountId, appId);
  // Keep the original lastFailureAt for same-version failures so the
  // cooldown can expire instead of being refreshed on every retry.
  const shouldPreserveTimestamp = marker.lastFailureVersion === version && marker.lastFailureAt;
  writeStartupMarker(accountId, appId, {
    ...marker,
    lastFailureVersion: version,
    lastFailureAt: shouldPreserveTimestamp ? marker.lastFailureAt! : new Date().toISOString(),
    lastFailureReason: reason,
  });
}
