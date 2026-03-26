/** Startup greeting policy for first launch and version upgrades. */

import * as fs from "node:fs";
import path from "node:path";
import { getPluginVersion } from "./slash-commands.js";
import { getQQBotDataDir } from "./utils/platform.js";

const STARTUP_MARKER_FILE = path.join(getQQBotDataDir("data"), "startup-marker.json");
const STARTUP_GREETING_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export function getFirstLaunchGreetingText(): string {
  return "The QQ Bot is online and ready.";
}

export function getUpgradeGreetingText(version: string): string {
  return `QQ Bot has been updated to v${version} and is ready.`;
}

export type StartupMarkerData = {
  version?: string;
  startedAt?: string;
  greetedAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  lastFailureVersion?: string;
};

export function readStartupMarker(): StartupMarkerData {
  try {
    if (fs.existsSync(STARTUP_MARKER_FILE)) {
      const data = JSON.parse(fs.readFileSync(STARTUP_MARKER_FILE, "utf8")) as StartupMarkerData;
      return data || {};
    }
  } catch {}
  return {};
}

export function writeStartupMarker(data: StartupMarkerData): void {
  try {
    fs.writeFileSync(STARTUP_MARKER_FILE, JSON.stringify(data) + "\n");
  } catch {
    // ignore
  }
}

/** Decide whether a startup greeting should be sent for the current version. */
export function getStartupGreetingPlan(): {
  shouldSend: boolean;
  greeting?: string;
  version: string;
  reason?: string;
} {
  const currentVersion = getPluginVersion();
  const marker = readStartupMarker();

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

export function markStartupGreetingSent(version: string): void {
  writeStartupMarker({
    version,
    startedAt: new Date().toISOString(),
    greetedAt: new Date().toISOString(),
  });
}

export function markStartupGreetingFailed(version: string, reason: string): void {
  const marker = readStartupMarker();
  // Preserve the first failure timestamp so the retry cooldown cannot extend forever.
  const shouldPreserveTimestamp = marker.lastFailureVersion === version && marker.lastFailureAt;
  writeStartupMarker({
    ...marker,
    lastFailureVersion: version,
    lastFailureAt: shouldPreserveTimestamp ? marker.lastFailureAt! : new Date().toISOString(),
    lastFailureReason: reason,
  });
}
