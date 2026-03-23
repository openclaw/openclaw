/**
 * 启动问候语系统：首次安装/版本更新 vs 普通重启
 */

import * as fs from "node:fs";
import path from "node:path";
import { getPluginVersion } from "./slash-commands.js";
import { getQQBotDataDir } from "./utils/platform.js";

const STARTUP_MARKER_FILE = path.join(getQQBotDataDir("data"), "startup-marker.json");
const STARTUP_GREETING_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export function getFirstLaunchGreetingText(): string {
  return `Haha，我的'灵魂'已上线，随时等你吩咐。`;
}

export function getUpgradeGreetingText(version: string): string {
  return `🎉 QQBot 插件已更新至 v${version}，在线等候你的吩咐。`;
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
  } catch {
    // 文件损坏或不存在，视为无 marker
  }
  return {};
}

export function writeStartupMarker(data: StartupMarkerData): void {
  try {
    fs.writeFileSync(STARTUP_MARKER_FILE, JSON.stringify(data) + "\n");
  } catch {
    // ignore
  }
}

/**
 * 判断是否需要发送启动问候：
 * - 首次启动（无 marker）→ "灵魂已上线"
 * - 版本变更 → "已更新至 vX.Y.Z"
 * - 同版本 → 不发送
 * - 同版本近期失败 → 冷却期内不重试
 */
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
  // 同版本已有失败记录时，不覆盖 lastFailureAt，避免冷却期被无限续期
  const shouldPreserveTimestamp = marker.lastFailureVersion === version && marker.lastFailureAt;
  writeStartupMarker({
    ...marker,
    lastFailureVersion: version,
    lastFailureAt: shouldPreserveTimestamp ? marker.lastFailureAt! : new Date().toISOString(),
    lastFailureReason: reason,
  });
}
