import path from "node:path";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  CODEX_WEB_SEARCH_MODES,
  type CodexBackchannelConfig,
  type CodexConfigObject,
  type CodexConfigValue,
  type CodexRouteConfig,
  type CodexSdkPluginConfig,
} from "./config-types.js";

type ParseResult = { ok: true; value?: CodexSdkPluginConfig } | { ok: false; message: string };
type RouteParseResult = { ok: true; value: CodexRouteConfig } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isCodexConfigValue(value: unknown): value is CodexConfigValue {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isCodexConfigValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isCodexConfigValue);
  }
  return false;
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function parseOptionalString(
  raw: Record<string, unknown>,
  key: keyof CodexSdkPluginConfig,
): string | undefined | ParseResult {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${String(key)} must be a non-empty string` };
  }
  return value.trim();
}

function parseOptionalRouteString(
  raw: Record<string, unknown>,
  key: keyof CodexRouteConfig,
): string | undefined | ParseResult {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `routes.*.${String(key)} must be a non-empty string` };
  }
  return value.trim();
}

function parseRouteConfig(routeId: string, value: unknown): RouteParseResult {
  if (!isRecord(value)) {
    return { ok: false, message: `routes.${routeId} must be an object` };
  }
  const allowedKeys = new Set([
    "model",
    "sandboxMode",
    "approvalPolicy",
    "modelReasoningEffort",
    "skipGitRepoCheck",
    "networkAccessEnabled",
    "webSearchMode",
    "additionalDirectories",
    "instructions",
    "aliases",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown routes.${routeId} key: ${key}` };
    }
  }

  const out: CodexRouteConfig = {};
  for (const key of ["model", "instructions"] as const) {
    const parsed = parseOptionalRouteString(value, key);
    if (isRecord(parsed) && parsed.ok === false) {
      return parsed;
    }
    if (typeof parsed === "string") {
      out[key] = parsed;
    }
  }

  if (value.sandboxMode !== undefined) {
    if (!isOneOf(value.sandboxMode, CODEX_SANDBOX_MODES)) {
      return {
        ok: false,
        message: `routes.${routeId}.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`,
      };
    }
    out.sandboxMode = value.sandboxMode;
  }

  if (value.approvalPolicy !== undefined) {
    if (!isOneOf(value.approvalPolicy, CODEX_APPROVAL_POLICIES)) {
      return {
        ok: false,
        message: `routes.${routeId}.approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(", ")}`,
      };
    }
    out.approvalPolicy = value.approvalPolicy;
  }

  if (value.modelReasoningEffort !== undefined) {
    if (!isOneOf(value.modelReasoningEffort, CODEX_REASONING_EFFORTS)) {
      return {
        ok: false,
        message: `routes.${routeId}.modelReasoningEffort must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}`,
      };
    }
    out.modelReasoningEffort = value.modelReasoningEffort;
  }

  if (value.webSearchMode !== undefined) {
    if (!isOneOf(value.webSearchMode, CODEX_WEB_SEARCH_MODES)) {
      return {
        ok: false,
        message: `routes.${routeId}.webSearchMode must be one of: ${CODEX_WEB_SEARCH_MODES.join(", ")}`,
      };
    }
    out.webSearchMode = value.webSearchMode;
  }

  for (const key of ["skipGitRepoCheck", "networkAccessEnabled"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        return { ok: false, message: `routes.${routeId}.${key} must be a boolean` };
      }
      out[key] = value[key];
    }
  }

  for (const key of ["additionalDirectories", "aliases"] as const) {
    if (value[key] !== undefined) {
      if (!isStringArray(value[key]) || value[key].some((entry) => entry.trim() === "")) {
        return {
          ok: false,
          message: `routes.${routeId}.${key} must be an array of non-empty strings`,
        };
      }
      out[key] = value[key].map((entry) => entry.trim());
    }
  }

  return { ok: true, value: out };
}

function parseBackchannelConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "backchannel must be an object" };
  }
  const allowedKeys = new Set([
    "enabled",
    "name",
    "command",
    "args",
    "env",
    "gatewayUrl",
    "allowedMethods",
    "readMethods",
    "safeWriteMethods",
    "requireWriteToken",
    "writeTokenEnv",
    "requestTimeoutMs",
    "maxPayloadBytes",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown backchannel key: ${key}` };
    }
  }

  const out: CodexBackchannelConfig = {};
  for (const key of ["enabled", "requireWriteToken"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        return { ok: false, message: `backchannel.${key} must be a boolean` };
      }
      out[key] = value[key];
    }
  }

  for (const key of ["name", "command", "gatewayUrl", "writeTokenEnv"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].trim() === "") {
        return { ok: false, message: `backchannel.${key} must be a non-empty string` };
      }
      out[key] = value[key].trim();
    }
  }

  if (out.name && !/^[a-zA-Z0-9_.-]+$/.test(out.name)) {
    return {
      ok: false,
      message: "backchannel.name may only contain letters, numbers, underscores, dots, and dashes",
    };
  }

  for (const key of ["args", "allowedMethods", "readMethods", "safeWriteMethods"] as const) {
    if (value[key] !== undefined) {
      if (!isStringArray(value[key]) || value[key].some((entry) => entry.trim() === "")) {
        return { ok: false, message: `backchannel.${key} must be an array of non-empty strings` };
      }
      out[key] = value[key].map((entry) => entry.trim());
    }
  }

  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      return { ok: false, message: "backchannel.env must be an object" };
    }
    const env: Record<string, string> = {};
    for (const [key, envValue] of Object.entries(value.env)) {
      if (!key.trim() || typeof envValue !== "string") {
        return {
          ok: false,
          message: "backchannel.env must contain non-empty string keys and string values",
        };
      }
      env[key] = envValue;
    }
    out.env = env;
  }

  for (const key of ["requestTimeoutMs", "maxPayloadBytes"] as const) {
    if (value[key] !== undefined) {
      if (!isPositiveInteger(value[key])) {
        return { ok: false, message: `backchannel.${key} must be a positive integer` };
      }
      out[key] = value[key];
    }
  }

  return { ok: true, value: out };
}

export function parseCodexSdkPluginConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }

  const allowedKeys = new Set([
    "codexPath",
    "cwd",
    "model",
    "sandboxMode",
    "approvalPolicy",
    "modelReasoningEffort",
    "skipGitRepoCheck",
    "networkAccessEnabled",
    "webSearchMode",
    "baseUrl",
    "apiKeyEnv",
    "inheritEnv",
    "env",
    "additionalDirectories",
    "allowedAgents",
    "defaultRoute",
    "routes",
    "maxEventsPerSession",
    "proposalInboxLimit",
    "config",
    "backchannel",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const out: CodexSdkPluginConfig = {};
  for (const key of [
    "codexPath",
    "cwd",
    "model",
    "baseUrl",
    "apiKeyEnv",
    "defaultRoute",
  ] as const) {
    const parsed = parseOptionalString(value, key);
    if (isRecord(parsed) && parsed.ok === false) {
      return parsed;
    }
    if (typeof parsed === "string") {
      out[key] = parsed;
    }
  }

  if (out.codexPath && !path.isAbsolute(out.codexPath)) {
    return { ok: false, message: "codexPath must be absolute when provided" };
  }

  if (value.sandboxMode !== undefined) {
    if (!isOneOf(value.sandboxMode, CODEX_SANDBOX_MODES)) {
      return {
        ok: false,
        message: `sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`,
      };
    }
    out.sandboxMode = value.sandboxMode;
  }

  if (value.approvalPolicy !== undefined) {
    if (!isOneOf(value.approvalPolicy, CODEX_APPROVAL_POLICIES)) {
      return {
        ok: false,
        message: `approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(", ")}`,
      };
    }
    out.approvalPolicy = value.approvalPolicy;
  }

  if (value.modelReasoningEffort !== undefined) {
    if (!isOneOf(value.modelReasoningEffort, CODEX_REASONING_EFFORTS)) {
      return {
        ok: false,
        message: `modelReasoningEffort must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}`,
      };
    }
    out.modelReasoningEffort = value.modelReasoningEffort;
  }

  if (value.webSearchMode !== undefined) {
    if (!isOneOf(value.webSearchMode, CODEX_WEB_SEARCH_MODES)) {
      return {
        ok: false,
        message: `webSearchMode must be one of: ${CODEX_WEB_SEARCH_MODES.join(", ")}`,
      };
    }
    out.webSearchMode = value.webSearchMode;
  }

  for (const key of ["skipGitRepoCheck", "networkAccessEnabled", "inheritEnv"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        return { ok: false, message: `${key} must be a boolean` };
      }
      out[key] = value[key];
    }
  }

  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      return { ok: false, message: "env must be an object" };
    }
    const env: Record<string, string> = {};
    for (const [key, envValue] of Object.entries(value.env)) {
      if (!key.trim() || typeof envValue !== "string") {
        return { ok: false, message: "env must contain non-empty string keys and string values" };
      }
      env[key] = envValue;
    }
    out.env = env;
  }

  for (const key of ["additionalDirectories", "allowedAgents"] as const) {
    if (value[key] !== undefined) {
      if (!isStringArray(value[key]) || value[key].some((entry) => entry.trim() === "")) {
        return { ok: false, message: `${key} must be an array of non-empty strings` };
      }
      out[key] = value[key].map((entry) => entry.trim());
    }
  }

  for (const key of ["maxEventsPerSession", "proposalInboxLimit"] as const) {
    if (value[key] !== undefined) {
      if (!isPositiveInteger(value[key])) {
        return { ok: false, message: `${key} must be a positive integer` };
      }
      out[key] = value[key];
    }
  }

  if (value.routes !== undefined) {
    if (!isRecord(value.routes)) {
      return { ok: false, message: "routes must be an object" };
    }
    const routes: Record<string, CodexRouteConfig> = {};
    for (const [rawRouteId, rawRouteConfig] of Object.entries(value.routes)) {
      const routeId = normalizeCodexRouteId(rawRouteId);
      if (!routeId) {
        return {
          ok: false,
          message: "routes keys must contain at least one alphanumeric character",
        };
      }
      const parsed = parseRouteConfig(routeId, rawRouteConfig);
      if (!parsed.ok) {
        return parsed;
      }
      routes[routeId] = parsed.value;
    }
    out.routes = routes;
  }

  if (value.config !== undefined) {
    if (!isRecord(value.config) || !isCodexConfigValue(value.config)) {
      return {
        ok: false,
        message:
          "config must be a plain JSON object containing strings, numbers, booleans, arrays, or objects",
      };
    }
    out.config = value.config as CodexConfigObject;
  }

  if (value.backchannel !== undefined) {
    const parsed = parseBackchannelConfig(value.backchannel);
    if (!parsed.ok) {
      return parsed;
    }
    out.backchannel = parsed.value;
  }

  return { ok: true, value: out };
}

export function normalizeCodexRouteId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  const withoutProvider = trimmed.startsWith("codex/")
    ? trimmed.slice("codex/".length)
    : trimmed.startsWith("codex-")
      ? trimmed.slice("codex-".length)
      : trimmed;
  return withoutProvider
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function normalizeCodexAgentAlias(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed
    .replace(/^codex\//, "codex-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
