import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryOpenVikingConfig = {
  baseUrl?: string;
  apiKey?: string;
  targetUri?: string;
  timeoutMs?: number;
  autoCapture?: boolean;
  autoRecall?: boolean;
  recallLimit?: number;
  recallScoreThreshold?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_TARGET_URI = "viking://";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RECALL_LIMIT = 6;
const DEFAULT_RECALL_SCORE_THRESHOLD = 0.01;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveDefaultBaseUrl(): string {
  const fromEnv = process.env.OPENVIKING_BASE_URL || process.env.OPENVIKING_URL;
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_BASE_URL;
}

export const memoryOpenVikingConfigSchema = {
  parse(value: unknown): Required<MemoryOpenVikingConfig> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      value = {};
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "baseUrl",
        "apiKey",
        "targetUri",
        "timeoutMs",
        "autoCapture",
        "autoRecall",
        "recallLimit",
        "recallScoreThreshold",
      ],
      "memory-openviking config",
    );

    const rawBaseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : resolveDefaultBaseUrl();
    const rawApiKey = typeof cfg.apiKey === "string" ? cfg.apiKey : process.env.OPENVIKING_API_KEY;

    return {
      baseUrl: resolveEnvVars(rawBaseUrl).replace(/\/+$/, ""),
      apiKey: rawApiKey ? resolveEnvVars(rawApiKey) : "",
      targetUri: typeof cfg.targetUri === "string" ? cfg.targetUri : DEFAULT_TARGET_URI,
      timeoutMs: Math.max(1000, Math.floor(toNumber(cfg.timeoutMs, DEFAULT_TIMEOUT_MS))),
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      recallLimit: Math.max(1, Math.floor(toNumber(cfg.recallLimit, DEFAULT_RECALL_LIMIT))),
      recallScoreThreshold: Math.min(
        1,
        Math.max(0, toNumber(cfg.recallScoreThreshold, DEFAULT_RECALL_SCORE_THRESHOLD)),
      ),
    };
  },
  uiHints: {
    baseUrl: {
      label: "OpenViking Base URL",
      placeholder: DEFAULT_BASE_URL,
      help: "HTTP URL of OpenViking server (or use ${OPENVIKING_BASE_URL})",
    },
    apiKey: {
      label: "OpenViking API Key",
      sensitive: true,
      placeholder: "${OPENVIKING_API_KEY}",
      help: "Optional API key for OpenViking server",
    },
    targetUri: {
      label: "Search Target URI",
      placeholder: DEFAULT_TARGET_URI,
      help: "Default OpenViking target URI for memory search",
    },
    timeoutMs: {
      label: "Request Timeout (ms)",
      placeholder: String(DEFAULT_TIMEOUT_MS),
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Extract memories from recent conversation messages via OpenViking sessions",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Inject relevant OpenViking memories into agent context",
    },
    recallLimit: {
      label: "Recall Limit",
      placeholder: String(DEFAULT_RECALL_LIMIT),
      advanced: true,
    },
    recallScoreThreshold: {
      label: "Recall Score Threshold",
      placeholder: String(DEFAULT_RECALL_SCORE_THRESHOLD),
      advanced: true,
    },
  },
};

export const DEFAULT_MEMORY_OPENVIKING_DATA_DIR = join(
  homedir(),
  ".openclaw",
  "memory",
  "openviking",
);
