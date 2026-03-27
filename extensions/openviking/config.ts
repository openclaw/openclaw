import { homedir } from "node:os";
import { join } from "node:path";
import { resolve as resolvePath } from "node:path";

export type MemoryOpenVikingConfig = {
  /** "local" = plugin starts OpenViking server as child process (like Claude Code); "remote" = use existing HTTP server */
  mode?: "local" | "remote";
  /** Path to ov.conf; used when mode is "local". Default ~/.openviking/ov.conf */
  configPath?: string;
  /** Port for local server when mode is "local". Ignored when mode is "remote". */
  port?: number;
  baseUrl?: string;
  agentId?: string;
  apiKey?: string;
  targetUri?: string;
  timeoutMs?: number;
  autoCapture?: boolean;
  captureMode?: "semantic" | "keyword";
  captureMaxLength?: number;
  autoRecall?: boolean;
  recallLimit?: number;
  recallScoreThreshold?: number;
  recallMaxContentChars?: number;
  recallPreferAbstract?: boolean;
  recallTokenBudget?: number;
  ingestReplyAssist?: boolean;
  ingestReplyAssistMinSpeakerTurns?: number;
  ingestReplyAssistMinChars?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_PORT = 1933;
const DEFAULT_TARGET_URI = "viking://user/memories";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CAPTURE_MODE = "semantic";
const DEFAULT_CAPTURE_MAX_LENGTH = 24000;
const DEFAULT_RECALL_LIMIT = 6;
const DEFAULT_RECALL_SCORE_THRESHOLD = 0.15;
const DEFAULT_RECALL_MAX_CONTENT_CHARS = 500;
const DEFAULT_RECALL_PREFER_ABSTRACT = true;
const DEFAULT_RECALL_TOKEN_BUDGET = 2000;
const DEFAULT_INGEST_REPLY_ASSIST = true;
const DEFAULT_INGEST_REPLY_ASSIST_MIN_SPEAKER_TURNS = 2;
const DEFAULT_INGEST_REPLY_ASSIST_MIN_CHARS = 120;
const DEFAULT_LOCAL_CONFIG_PATH = join(homedir(), ".openviking", "ov.conf");

const DEFAULT_AGENT_ID = "default";

function resolveAgentId(configured: unknown): string {
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return DEFAULT_AGENT_ID;
}

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
        "mode",
        "configPath",
        "port",
        "baseUrl",
        "agentId",
        "apiKey",
        "targetUri",
        "timeoutMs",
        "autoCapture",
        "captureMode",
        "captureMaxLength",
        "autoRecall",
        "recallLimit",
        "recallScoreThreshold",
        "recallMaxContentChars",
        "recallPreferAbstract",
        "recallTokenBudget",
        "ingestReplyAssist",
        "ingestReplyAssistMinSpeakerTurns",
        "ingestReplyAssistMinChars",
      ],
      "openviking config",
    );

    const mode = (cfg.mode === "local" || cfg.mode === "remote" ? cfg.mode : "local") as
      | "local"
      | "remote";
    const port = Math.max(1, Math.min(65535, Math.floor(toNumber(cfg.port, DEFAULT_PORT))));
    const rawConfigPath =
      typeof cfg.configPath === "string" && cfg.configPath.trim()
        ? cfg.configPath.trim()
        : DEFAULT_LOCAL_CONFIG_PATH;
    const configPath = resolvePath(
      resolveEnvVars(rawConfigPath).replace(/^~/, homedir()),
    );

    const localBaseUrl = `http://127.0.0.1:${port}`;
    const rawBaseUrl =
      mode === "local" ? localBaseUrl : (typeof cfg.baseUrl === "string" ? cfg.baseUrl : resolveDefaultBaseUrl());
    const resolvedBaseUrl = resolveEnvVars(rawBaseUrl).replace(/\/+$/, "");
    const rawApiKey = typeof cfg.apiKey === "string" ? cfg.apiKey : process.env.OPENVIKING_API_KEY;
    const captureMode = cfg.captureMode;
    if (
      typeof captureMode !== "undefined" &&
      captureMode !== "semantic" &&
      captureMode !== "keyword"
    ) {
      throw new Error(`openviking captureMode must be "semantic" or "keyword"`);
    }

    return {
      mode,
      configPath,
      port,
      baseUrl: resolvedBaseUrl,
      agentId: resolveAgentId(cfg.agentId),
      apiKey: rawApiKey ? resolveEnvVars(rawApiKey) : "",
      targetUri: typeof cfg.targetUri === "string" ? cfg.targetUri : DEFAULT_TARGET_URI,
      timeoutMs: Math.max(1000, Math.floor(toNumber(cfg.timeoutMs, DEFAULT_TIMEOUT_MS))),
      autoCapture: cfg.autoCapture !== false,
      captureMode: captureMode ?? DEFAULT_CAPTURE_MODE,
      captureMaxLength: Math.max(
        200,
        Math.min(200_000, Math.floor(toNumber(cfg.captureMaxLength, DEFAULT_CAPTURE_MAX_LENGTH))),
      ),
      autoRecall: cfg.autoRecall !== false,
      recallLimit: Math.max(1, Math.floor(toNumber(cfg.recallLimit, DEFAULT_RECALL_LIMIT))),
      recallScoreThreshold: Math.min(
        1,
        Math.max(0, toNumber(cfg.recallScoreThreshold, DEFAULT_RECALL_SCORE_THRESHOLD)),
      ),
      recallMaxContentChars: Math.max(
        50,
        Math.min(10000, Math.floor(toNumber(cfg.recallMaxContentChars, DEFAULT_RECALL_MAX_CONTENT_CHARS))),
      ),
      recallPreferAbstract: cfg.recallPreferAbstract !== false,
      recallTokenBudget: Math.max(
        100,
        Math.min(50000, Math.floor(toNumber(cfg.recallTokenBudget, DEFAULT_RECALL_TOKEN_BUDGET))),
      ),
      ingestReplyAssist: cfg.ingestReplyAssist !== false,
      ingestReplyAssistMinSpeakerTurns: Math.max(
        1,
        Math.min(
          12,
          Math.floor(
            toNumber(
              cfg.ingestReplyAssistMinSpeakerTurns,
              DEFAULT_INGEST_REPLY_ASSIST_MIN_SPEAKER_TURNS,
            ),
          ),
        ),
      ),
      ingestReplyAssistMinChars: Math.max(
        32,
        Math.min(
          10000,
          Math.floor(toNumber(cfg.ingestReplyAssistMinChars, DEFAULT_INGEST_REPLY_ASSIST_MIN_CHARS)),
        ),
      ),
    };
  },
  uiHints: {
    mode: {
      label: "Mode",
      help: "local = plugin starts OpenViking server (like Claude Code); remote = use existing HTTP server",
    },
    configPath: {
      label: "Config path (local)",
      placeholder: DEFAULT_LOCAL_CONFIG_PATH,
      help: "Path to ov.conf when mode is local",
    },
    port: {
      label: "Port (local)",
      placeholder: String(DEFAULT_PORT),
      help: "Port for local OpenViking server",
      advanced: true,
    },
    baseUrl: {
      label: "OpenViking Base URL (remote)",
      placeholder: DEFAULT_BASE_URL,
      help: "HTTP URL when mode is remote (or use ${OPENVIKING_BASE_URL})",
    },
    agentId: {
      label: "Agent ID",
      placeholder: "auto-generated",
      help: "Identifies this agent to OpenViking (sent as X-OpenViking-Agent header). Defaults to \"default\" if not set.",
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
    captureMode: {
      label: "Capture Mode",
      placeholder: DEFAULT_CAPTURE_MODE,
      advanced: true,
      help: '"semantic" captures all eligible user text and relies on OpenViking extraction; "keyword" uses trigger regex first.',
    },
    captureMaxLength: {
      label: "Capture Max Length",
      placeholder: String(DEFAULT_CAPTURE_MAX_LENGTH),
      advanced: true,
      help: "Maximum sanitized user text length allowed for auto-capture.",
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
    recallMaxContentChars: {
      label: "Recall Max Content Chars",
      placeholder: String(DEFAULT_RECALL_MAX_CONTENT_CHARS),
      advanced: true,
      help: "Maximum characters per memory content in auto-recall injection. Content exceeding this is truncated.",
    },
    recallPreferAbstract: {
      label: "Recall Prefer Abstract",
      advanced: true,
      help: "Use memory abstract instead of fetching full content when abstract is available. Reduces token usage.",
    },
    recallTokenBudget: {
      label: "Recall Token Budget",
      placeholder: String(DEFAULT_RECALL_TOKEN_BUDGET),
      advanced: true,
      help: "Maximum estimated tokens for auto-recall memory injection. Injection stops when budget is exhausted.",
    },
    ingestReplyAssist: {
      label: "Ingest Reply Assist",
      help: "When transcript-like memory ingestion is detected, add a lightweight reply instruction to reduce NO_REPLY.",
      advanced: true,
    },
    ingestReplyAssistMinSpeakerTurns: {
      label: "Ingest Min Speaker Turns",
      placeholder: String(DEFAULT_INGEST_REPLY_ASSIST_MIN_SPEAKER_TURNS),
      help: "Minimum speaker-tag turns (e.g. Name:) to detect transcript-like ingest text.",
      advanced: true,
    },
    ingestReplyAssistMinChars: {
      label: "Ingest Min Chars",
      placeholder: String(DEFAULT_INGEST_REPLY_ASSIST_MIN_CHARS),
      help: "Minimum sanitized text length required before ingest reply assist can trigger.",
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
