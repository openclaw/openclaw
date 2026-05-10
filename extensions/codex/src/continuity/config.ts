import os from "node:os";
import path from "node:path";

export type CodexContinuityBridgeConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  watchTtlMs: number;
  sqliteStatePath: string;
  maxThreads: number;
  notifyChannel: string;
  notifyTarget?: string;
  enableTelegramWrites: boolean;
  allowedRepos: string[];
  trustedTelegramSenders: string[];
  confirmedWriteMethods: string[];
  devNotifyTestEnabled: boolean;
  telegramDryRun: boolean;
};

const DEFAULT_WATCH_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_THREADS = 25;

export function resolveCodexContinuityBridgeConfig(
  pluginConfig: unknown,
): CodexContinuityBridgeConfig {
  const bridge = isPlainRecord(pluginConfig)
    ? (readObject(pluginConfig.codexBridge) ?? readObject(pluginConfig.continuityBridge) ?? {})
    : {};
  return {
    enabled: readBoolean(bridge.enabled, true),
    pollIntervalMs: clampInt(bridge.pollIntervalMs, 5_000, 60 * 60_000, DEFAULT_POLL_INTERVAL_MS),
    watchTtlMs: clampInt(bridge.watchTtlMs, 60_000, 30 * 24 * 60 * 60_000, DEFAULT_WATCH_TTL_MS),
    sqliteStatePath: expandUserPath(
      readString(bridge.sqliteStatePath) ??
        path.join(
          readString(process.env.CODEX_HOME) ?? path.join(os.homedir(), ".codex"),
          "state_5.sqlite",
        ),
    ),
    maxThreads: clampInt(bridge.maxThreads, 1, 100, DEFAULT_MAX_THREADS),
    notifyChannel: readString(bridge.notifyChannel) ?? "telegram",
    notifyTarget: readString(bridge.notifyTarget),
    enableTelegramWrites: readBoolean(bridge.enableTelegramWrites, false),
    allowedRepos: readStringArray(bridge.allowedRepos).map(expandUserPath),
    trustedTelegramSenders: readStringArray(bridge.trustedTelegramSenders),
    confirmedWriteMethods: readStringArray(bridge.confirmedWriteMethods),
    devNotifyTestEnabled: readBoolean(bridge.devNotifyTestEnabled, false),
    telegramDryRun: readBoolean(bridge.telegramDryRun, false),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter((entry): entry is string => Boolean(entry));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function expandUserPath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
