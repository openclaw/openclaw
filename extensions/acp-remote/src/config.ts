import { isAbsolute } from "node:path";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/acp";

export const ACP_REMOTE_PROTOCOL_VERSION = 1;

export type AcpRemotePluginConfig = {
  url?: string;
  defaultCwd?: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  retryDelayMs?: number;
  protocolVersion?: number;
};

export type ResolvedAcpRemotePluginConfig = {
  url: string;
  defaultCwd?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retryDelayMs: number;
  protocolVersion: number;
};

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 150;

type ParseResult =
  | { ok: true; value: AcpRemotePluginConfig | undefined }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function parseAcpRemotePluginConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }

  const allowedKeys = new Set([
    "url",
    "defaultCwd",
    "headers",
    "timeoutSeconds",
    "retryDelayMs",
    "protocolVersion",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const url = normalizeText(value.url);
  if (!url) {
    return { ok: false, message: "url must be a non-empty string" };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, message: "url must be a valid absolute URL" };
  }

  const defaultCwd = normalizeText(value.defaultCwd);
  if (value.defaultCwd !== undefined) {
    if (!defaultCwd) {
      return { ok: false, message: "defaultCwd must be a non-empty string" };
    }
    if (!isAbsolute(defaultCwd)) {
      return { ok: false, message: "defaultCwd must be an absolute path" };
    }
  }

  const headers = value.headers;
  if (headers !== undefined && !isStringMap(headers)) {
    return { ok: false, message: "headers must be an object of string values" };
  }

  const timeoutSeconds = value.timeoutSeconds;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    return { ok: false, message: "timeoutSeconds must be a positive number" };
  }

  const retryDelayMs = value.retryDelayMs;
  if (
    retryDelayMs !== undefined &&
    (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs) || retryDelayMs < 0)
  ) {
    return { ok: false, message: "retryDelayMs must be a non-negative number" };
  }

  const protocolVersion = value.protocolVersion;
  if (
    protocolVersion !== undefined &&
    (!Number.isInteger(protocolVersion) || protocolVersion < 1 || protocolVersion > 65_535)
  ) {
    return { ok: false, message: "protocolVersion must be an integer between 1 and 65535" };
  }

  return {
    ok: true,
    value: {
      url,
      defaultCwd,
      headers: headers as Record<string, string> | undefined,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : undefined,
      retryDelayMs: typeof retryDelayMs === "number" ? retryDelayMs : undefined,
      protocolVersion: typeof protocolVersion === "number" ? protocolVersion : undefined,
    },
  };
}

export function createAcpRemotePluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown):
      | { success: true; data?: unknown }
      | {
          success: false;
          error: { issues: Array<{ path: Array<string | number>; message: string }> };
        } {
      const parsed = parseAcpRemotePluginConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: parsed.message }],
        },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string" },
        defaultCwd: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        timeoutSeconds: { type: "number", minimum: 0.001 },
        retryDelayMs: { type: "number", minimum: 0 },
        protocolVersion: {
          type: "integer",
          minimum: 1,
          maximum: 65_535,
        },
      },
    },
  };
}

export function resolveAcpRemotePluginConfig(params: {
  rawConfig: unknown;
}): ResolvedAcpRemotePluginConfig {
  const parsed = parseAcpRemotePluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  const normalized = parsed.value ?? {};
  return {
    url: new URL(normalized.url ?? "").toString(),
    defaultCwd: normalized.defaultCwd,
    headers: { ...(normalized.headers ?? {}) },
    timeoutMs: Math.round((normalized.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
    retryDelayMs: Math.max(0, Math.round(normalized.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
    protocolVersion: normalized.protocolVersion ?? ACP_REMOTE_PROTOCOL_VERSION,
  };
}
