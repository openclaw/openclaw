import type { AppsConfig } from "./codex-sdk/generated/protocol/v2/AppsConfig.js";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";
const DEFAULT_APP_SERVER_COMMAND = "codex";
const DEFAULT_LINK_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_LINK_POLL_INTERVAL_MS = 3_000;

export type ChatgptAppsConfig = {
  enabled: boolean;
  chatgptBaseUrl: string;
  appServer: {
    command: string;
    args: string[];
  };
  linking: {
    enabled: boolean;
    waitTimeoutMs: number;
    pollIntervalMs: number;
  };
  connectors: Record<string, { enabled: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeAppServerArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .filter((entry) => entry !== "app-server" && entry !== "--analytics-default-enabled");
}

function normalizeConnectors(value: unknown): ChatgptAppsConfig["connectors"] {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: ChatgptAppsConfig["connectors"] = {};
  for (const [connectorId, entry] of Object.entries(value)) {
    const trimmedId = connectorId.trim();
    if (!trimmedId) {
      continue;
    }
    normalized[trimmedId] = {
      enabled: !isRecord(entry) || typeof entry.enabled !== "boolean" ? true : entry.enabled,
    };
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export function resolveChatgptAppsConfig(pluginConfig: unknown): ChatgptAppsConfig {
  const raw =
    isRecord(pluginConfig) && isRecord(pluginConfig.chatgptApps) ? pluginConfig.chatgptApps : {};
  const appServer = isRecord(raw.appServer) ? raw.appServer : {};
  const linking = isRecord(raw.linking) ? raw.linking : {};

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    chatgptBaseUrl: normalizeNonEmptyString(raw.chatgptBaseUrl) ?? DEFAULT_CHATGPT_BASE_URL,
    appServer: {
      command: normalizeNonEmptyString(appServer.command) ?? DEFAULT_APP_SERVER_COMMAND,
      args: normalizeAppServerArgs(appServer.args),
    },
    linking: {
      enabled: typeof linking.enabled === "boolean" ? linking.enabled : false,
      waitTimeoutMs: normalizePositiveInteger(linking.waitTimeoutMs, DEFAULT_LINK_WAIT_TIMEOUT_MS),
      pollIntervalMs: normalizePositiveInteger(
        linking.pollIntervalMs,
        DEFAULT_LINK_POLL_INTERVAL_MS,
      ),
    },
    connectors: normalizeConnectors(raw.connectors),
  };
}

export function buildDerivedAppsConfig(config: ChatgptAppsConfig): AppsConfig {
  const apps: Record<string, { enabled: boolean }> = {};
  const wildcardEnabled = config.connectors["*"]?.enabled ?? false;

  for (const [connectorId, connector] of Object.entries(config.connectors)) {
    apps[connectorId] = {
      enabled: connector.enabled,
    };
  }

  return {
    _default: {
      enabled: wildcardEnabled,
      destructive_enabled: false,
      open_world_enabled: false,
    },
    ...apps,
  } as AppsConfig;
}
