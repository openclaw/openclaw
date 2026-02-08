import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

type HaServiceField = {
  name?: string;
  description?: string;
  required?: boolean;
  selector?: unknown;
};

type HaServiceDefinition = {
  name?: string;
  description?: string;
  fields?: Record<string, HaServiceField>;
};

type HaServices = Record<string, Record<string, HaServiceDefinition>>;

type VerificationMethod = "state_poll" | "ws_event" | "attribute_check" | "none";
type VerificationLevel = "ha_event" | "state" | "none";

type VerificationResult = {
  attempted: boolean;
  ok: boolean;
  level: VerificationLevel;
  method: VerificationMethod;
  reason: string;
  targets: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
};

type RegistryArea = {
  area_id: string;
  name: string;
};

type RegistryDevice = {
  id: string;
  name: string;
  area_id: string;
  model: string;
  manufacturer: string;
  identifiers?: string[][];
  via_device_id?: string;
};

type RegistryEntity = {
  entity_id: string;
  unique_id: string;
  platform: string;
  device_id: string;
  area_id: string;
  name: string;
  disabled_by?: string | null;
  original_name?: string;
  original_device_class?: string;
  config_entry_id?: string;
  entity_category?: string | null;
  device_class?: string | null;
};

type InventoryEntity = {
  domain: string;
  entity_id: string;
  friendly_name: string;
  original_name: string;
  aliases: string[];
  device_id: string;
  area_id: string;
  area_name: string;
  device_name: string;
  manufacturer: string;
  model: string;
  device_fingerprint?: string;
  integration: string;
  platform: string;
  state?: string;
  device_class?: string | null;
  original_device_class?: string;
  config_entry_id?: string;
  entity_category?: string | null;
  disabled_by?: string | null;
  unique_id?: string;
  device_identifiers?: string[][];
  via_device_id?: string;
  attributes: Record<string, unknown>;
  capabilities_hints?: Record<string, unknown>;
  services: string[];
};

type DeviceGraphEntry = {
  device_id: string;
  device_name: string;
  area_id: string;
  area_name: string;
  manufacturer: string;
  model: string;
  identifiers: string[][];
  via_device_id: string;
  entity_ids: string[];
  entity_unique_ids: string[];
  entity_domains: string[];
  integration_domains: string[];
  device_fingerprint: string;
};

type SemanticResult = {
  semantic_type: string;
  confidence: number;
  reasons: string[];
  source: "override" | "inferred";
};

type SemanticOverrideEntry = {
  semantic_type?: string;
  control_model?: string;
  smoke_test_safe?: boolean;
  notes?: string;
  ts?: string;
};

type SemanticOverrideStore = {
  entity_overrides: Record<string, SemanticOverrideEntry>;
  device_overrides: Record<string, SemanticOverrideEntry>;
};

type SemanticResolution = {
  semantic_type: string;
  control_model: string;
  confidence: number;
  reasons: string[];
  missing_signals: string[];
  non_actionable?: boolean;
  recommended_primary: string;
  recommended_fallbacks: string[];
  smoke_test_safe: boolean;
  preferred_control_entity?: string;
  entity_fingerprint?: Record<string, unknown>;
  source: "override" | "inferred";
  ambiguity: { ok: boolean; reason?: string; needs_override?: boolean };
};

type RequestOptions = {
  method: string;
  url: string;
  token: string;
  body?: unknown;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const TRACE_ROTATE_BYTES = 5 * 1024 * 1024;
const TRACE_PATH = `${process.env.HOME ?? "/home/node"}/.openclaw/logs/homeassistant-tools.jsonl`;
const TOOL_DEDUPE_TTL_MS = 15000;
const TOOL_DEDUPE_MAX = 200;
const SERVICES_CACHE_TTL_MS = 15000;
const STATES_CACHE_TTL_MS = 1500;
const SEMANTIC_DATA_DIR = `${process.env.HOME ?? "/home/node"}/.openclaw/homeassistant`;
const SEMANTIC_OVERRIDES_PATH = `${SEMANTIC_DATA_DIR}/semantic_overrides.json`;
const SEMANTIC_STATS_PATH = `${SEMANTIC_DATA_DIR}/semantic_stats.json`;
const SEMANTIC_LEARNED_PATH = `${SEMANTIC_DATA_DIR}/semantic_learned.json`;
const RELIABILITY_STATS_PATH = `${SEMANTIC_DATA_DIR}/reliability_stats.json`;
const RISK_APPROVALS_PATH = `${SEMANTIC_DATA_DIR}/risk_approvals.json`;
const RISK_POLICY_PATH = `${SEMANTIC_DATA_DIR}/risk_policy.json`;
const RISK_POLICY_STATE_PATH = `${SEMANTIC_DATA_DIR}/risk_policy_state.json`;
const DEFAULT_LEARNED_SUCCESS_THRESHOLD = 3;
const SENSITIVE_KEYS = ["token", "authorization", "secret", "password", "apikey", "bearer", "key"];
const DEFAULT_HELPER_DOMAINS = [
  "input_boolean",
  "input_number",
  "input_text",
  "input_select",
  "input_datetime",
  "input_button",
];
const LIGHT_LIST_DEFAULT_FIELDS = [
  "entity_id",
  "name",
  "friendly_name",
  "state",
  "supported_color_modes",
  "brightness",
  "color_mode",
  "color_temp_kelvin",
];
const traceContext = new AsyncLocalStorage<{ channelIdentity?: string }>();
type ToolDedupeEntry = {
  ts: number;
  result: ToolResult;
};
const toolDedupeCache = new Map<string, Map<string, ToolDedupeEntry>>();
let haServicesCache: { ts: number; data: HaServices } | null = null;
let haStatesCache: { ts: number; data: HaState[] } | null = null;

const redactString = (value: string) => {
  if (value.toLowerCase().startsWith("bearer ")) return "REDACTED";
  const tail = value.length > 4 ? value.slice(-4) : value;
  return `REDACTED...${tail}`;
};

const redactObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (typeof val === "string" && SENSITIVE_KEYS.some((needle) => lower.includes(needle))) {
        output[key] = redactString(val);
      } else if (typeof val === "string" && val.toLowerCase().startsWith("bearer ")) {
        output[key] = "REDACTED";
      } else {
        output[key] = redactObject(val);
      }
    }
    return output;
  }
  return value;
};

const sanitizeError = (value: unknown) => {
  if (!value) return undefined;
  const text = String(value);
  if (text.toLowerCase().includes("bearer ")) return "REDACTED";
  return text;
};

const safeString = (value: unknown) => (typeof value === "string" ? value : "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getChannelIdentity = (ctx?: OpenClawPluginToolContext) => {
  const channel = safeString(ctx?.messageChannel).trim() || "unknown";
  const account = safeString(ctx?.agentAccountId).trim() || "unknown";
  const agentId = safeString(ctx?.agentId).trim() || "unknown";
  const sessionKey = safeString(ctx?.sessionKey).trim() || "";
  return sessionKey ? `${channel}:${account}:${agentId}:${sessionKey}` : `${channel}:${account}:${agentId}`;
};

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
};

const getDedupeBucket = (channelIdentity: string) => {
  const existing = toolDedupeCache.get(channelIdentity);
  if (existing) return existing;
  const created = new Map<string, ToolDedupeEntry>();
  toolDedupeCache.set(channelIdentity, created);
  return created;
};

const pruneDedupeBucket = (bucket: Map<string, ToolDedupeEntry>, now: number) => {
  for (const [key, entry] of bucket.entries()) {
    if (now - entry.ts > TOOL_DEDUPE_TTL_MS) {
      bucket.delete(key);
    }
  }
  if (bucket.size <= TOOL_DEDUPE_MAX) return;
  const sorted = [...bucket.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const removeCount = bucket.size - TOOL_DEDUPE_MAX;
  for (let i = 0; i < removeCount; i += 1) {
    bucket.delete(sorted[i]?.[0] ?? "");
  }
};

const isToolResultErrorText = (result: ToolResult) =>
  result.content.some((block) => block.type === "text" && /error/i.test(block.text));

const formatLocalTime = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

const formatLocalTimeSafe = (date: Date, timeZone: string) => {
  try {
    return formatLocalTime(date, timeZone);
  } catch {
    return formatLocalTime(date, "UTC");
  }
};

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withToolContext = (
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (id: string, params?: Record<string, unknown>) => Promise<ToolResult>;
  },
  ctx?: OpenClawPluginToolContext,
) => {
  const channelIdentity = getChannelIdentity(ctx);
  return {
    ...tool,
    execute: (id: string, params: Record<string, unknown>) =>
      traceContext.run({ channelIdentity }, async () => {
        const now = Date.now();
        const bucket = getDedupeBucket(channelIdentity);
        pruneDedupeBucket(bucket, now);
        const dedupeKey = `${tool.name}:${stableStringify(params ?? {})}`;
        const cached = bucket.get(dedupeKey);
        if (cached && now - cached.ts <= TOOL_DEDUPE_TTL_MS) {
          await traceToolCall({
            tool: tool.name,
            params,
            durationMs: 0,
            ok: true,
            dedupHit: true,
          });
          return cached.result;
        }
        const result = await tool.execute(id, params);
        if (!isToolResultErrorText(result)) {
          bucket.set(dedupeKey, { ts: now, result });
        }
        return result;
      }),
  };
};

const traceToolCall = async (input: {
  tool: string;
  params?: Record<string, unknown>;
  httpStatus?: number;
  durationMs: number;
  ok: boolean;
  error?: unknown;
  endpoint?: string;
  resultBytes?: number;
  channelIdentity?: string;
  dedupHit?: boolean;
}) => {
  try {
    await mkdir(dirname(TRACE_PATH), { recursive: true });
    try {
      const stats = await stat(TRACE_PATH);
      if (stats.size >= TRACE_ROTATE_BYTES) {
        await rename(TRACE_PATH, `${TRACE_PATH}.1`).catch(() => undefined);
      }
    } catch {
      // ignore missing file
    }
    const channelIdentity =
      input.channelIdentity ?? traceContext.getStore()?.channelIdentity ?? null;
    const record = {
      ts: new Date().toISOString(),
      tool: input.tool,
      args_redacted: input.params ? redactObject(input.params) : {},
      http_status: input.httpStatus ?? null,
      duration_ms: input.durationMs,
      ok: input.ok,
      dedup_hit: input.dedupHit ?? false,
      error: input.error ? sanitizeError(input.error) : null,
      ha_endpoint_or_ws_type: input.endpoint ?? null,
      result_bytes: input.resultBytes ?? null,
      channel_identity: channelIdentity,
    };
    await appendFile(TRACE_PATH, `${JSON.stringify(record)}\n`);
  } catch {
    // Never throw from tracer
  }
};

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}. Set ${key} in env.`);
  return value;
};

const getOptionalEnvNumber = (key: string, fallback: number, input?: { min?: number; max?: number }) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const min = input?.min;
  const max = input?.max;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
};

const LEARNED_SUCCESS_THRESHOLD = getOptionalEnvNumber(
  "OPENCLAW_HA_LEARNED_THRESHOLD",
  DEFAULT_LEARNED_SUCCESS_THRESHOLD,
  { min: 1, max: 10 },
);

const normalizeBaseUrl = (value: string) => value.replace(/\/$/, "");

class DeadlineError extends Error {
  label: string;
  stage: string;
  elapsedMs: number;

  constructor(label: string, stage: string, elapsedMs: number) {
    super(`${label} deadline exceeded at ${stage}`);
    this.label = label;
    this.stage = stage;
    this.elapsedMs = elapsedMs;
  }
}

const withDeadline = async <T>(input: {
  label: string;
  deadlineMs: number;
  getStage: () => string;
  fn: () => Promise<T>;
}): Promise<T> => {
  const started = Date.now();
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new DeadlineError(input.label, input.getStage(), Date.now() - started));
    }, input.deadlineMs);
    input
      .fn()
      .then((res) => {
        clearTimeout(timeout);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
};

const isTransientStatus = (status?: number) =>
  status === 429 || status === 502 || status === 503 || status === 504;

const isTransientError = (err: unknown) => {
  const text = String(err ?? "");
  return /aborterror|fetch failed|econnreset|etimedout|enotfound|econnrefused/i.test(text);
};

const requestJson = async ({ method, url, token, body, timeoutMs }: RequestOptions) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const bytes = Buffer.byteLength(text ?? "", "utf8");
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const requestJsonWithRetry = async (input: RequestOptions, retryDelaysMs: number[] = []) => {
  const attempts: Array<{ attempt: number; ok: boolean; status?: number; error?: string }> = [];
  for (let i = 0; i < retryDelaysMs.length + 1; i += 1) {
    try {
      const res = await requestJson(input);
      attempts.push({ attempt: i + 1, ok: res.ok, status: res.status });
      if (!res.ok && isTransientStatus(res.status) && i < retryDelaysMs.length) {
        await sleep(retryDelaysMs[i]);
        continue;
      }
      return { res, attempts };
    } catch (err) {
      attempts.push({ attempt: i + 1, ok: false, error: String(err) });
      if (isTransientError(err) && i < retryDelaysMs.length) {
        await sleep(retryDelaysMs[i]);
        continue;
      }
      throw err;
    }
  }
  throw new Error("requestJsonWithRetry exhausted");
};

const requestText = async ({ method, url, token, body, timeoutMs }: RequestOptions) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const bytes = Buffer.byteLength(text ?? "", "utf8");

    return {
      ok: response.ok,
      status: response.status,
      text,
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const getHaBaseUrl = () => normalizeBaseUrl(requireEnv("HA_URL"));
const getHaToken = () => requireEnv("HA_TOKEN");
const getHaWsUrl = () => getHaBaseUrl().replace(/^http/, "ws") + "/api/websocket";

const HA_CONFIG_TTL_MS = 60 * 1000;
let haConfigCache: { ts: number; data: Record<string, unknown> } | null = null;

const fetchHaConfig = async () => {
  const now = Date.now();
  if (haConfigCache && now - haConfigCache.ts < HA_CONFIG_TTL_MS) {
    return haConfigCache.data;
  }
  const baseUrl = getHaBaseUrl();
  const token = getHaToken();
  const res = await requestJson({
    method: "GET",
    url: `${baseUrl}/api/config`,
    token,
  });
  if (!res.ok || typeof res.data !== "object" || res.data === null) {
    return null;
  }
  haConfigCache = { ts: now, data: res.data as Record<string, unknown> };
  return haConfigCache.data;
};

const getHaTimeZone = async () => {
  try {
    const config = await fetchHaConfig();
    if (config && typeof config.time_zone === "string") {
      return config.time_zone;
    }
  } catch {
    // ignore time_zone failures
  }
  return "UTC";
};

const normalizeServicesFromRest = (data: unknown): HaServices | null => {
  if (!Array.isArray(data)) return null;
  const output: HaServices = {};
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const domain = safeString((entry as Record<string, unknown>)["domain"]);
    const services = (entry as Record<string, unknown>)["services"];
    if (!domain || !services || typeof services !== "object") continue;
    output[domain] = services as Record<string, HaServiceDefinition>;
  }
  return output;
};

const fetchStatesWs = async () => {
  const now = Date.now();
  if (haStatesCache && now - haStatesCache.ts < STATES_CACHE_TTL_MS) {
    return { ok: true, data: haStatesCache.data };
  }
  const res = await wsCall("get_states");
  const ok = res.success && Array.isArray(res.result);
  if (ok) {
    haStatesCache = { ts: now, data: res.result as HaState[] };
    return { ok: true, data: haStatesCache.data };
  }
  return { ok: false, data: null };
};

const fetchStates = async () => {
  const wsRes = await fetchStatesWs();
  if (wsRes.ok && Array.isArray(wsRes.data)) {
    return { ok: true, data: wsRes.data };
  }
  const baseUrl = getHaBaseUrl();
  const token = getHaToken();
  return await requestJson({
    method: "GET",
    url: `${baseUrl}/api/states`,
    token,
  });
};

const fetchServices = async () => {
  const now = Date.now();
  if (haServicesCache && now - haServicesCache.ts < SERVICES_CACHE_TTL_MS) {
    return { ok: true, data: haServicesCache.data, bytes: 0, success: true };
  }
  const res = await wsCall("get_services");
  const ok = res.success && typeof res.result === "object" && res.result !== null;
  if (ok) {
    haServicesCache = { ts: now, data: res.result as HaServices };
    return { ...res, ok: true, data: haServicesCache.data };
  }
  const baseUrl = getHaBaseUrl();
  const token = getHaToken();
  const restRes = await requestJson({
    method: "GET",
    url: `${baseUrl}/api/services`,
    token,
  });
  if (restRes.ok) {
    const normalized = normalizeServicesFromRest(restRes.data);
    if (normalized) {
      haServicesCache = { ts: now, data: normalized };
      return { ok: true, data: normalized, bytes: restRes.bytes, success: true };
    }
  }
  return { ok: false, data: null, bytes: restRes.bytes ?? 0, success: false };
};

const WS_ALLOWED_TYPES = new Set([
  "config/area_registry/list",
  "config/device_registry/list",
  "config/entity_registry/list",
  "get_services",
  "get_states",
  "call_service",
  "config/core/check_config",
  "system_log/list",
]);

const normalizeWsType = (type: string) => {
  if (type === "validate_config") return "config/core/check_config";
  return type;
};

const wsCall = async (type: string, payload: Record<string, unknown> = {}) => {
  const normalizedType = normalizeWsType(type);
  if (!WS_ALLOWED_TYPES.has(normalizedType)) {
    throw new Error(`WS type not allowed: ${type}`);
  }

  const wsUrl = getHaWsUrl();
  const token = getHaToken();

  return new Promise<{ success: boolean; result?: unknown; error?: unknown; bytes: number }>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`WS timeout for ${type}`));
    }, DEFAULT_TIMEOUT_MS);

    const finish = (value: { success: boolean; result?: unknown; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      const bytes = Buffer.byteLength(JSON.stringify(value.result ?? value.error ?? ""), "utf8");
      resolve({ ...value, bytes });
    };

    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error("WS error"));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type?: string;
          id?: number;
          success?: boolean;
          result?: unknown;
          error?: unknown;
        };

        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (msg.type === "auth_invalid") {
          finish({ success: false, error: msg.error ?? "auth_invalid" });
          return;
        }
        if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id, type: normalizedType, ...payload }));
          return;
        }
        if (msg.id === id) {
          finish({ success: Boolean(msg.success), result: msg.result, error: msg.error });
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error("WS parse error"));
      }
    };
  });
};

const wsTraceServiceCommand = async (input: {
  entityIds: string[];
  domain: string;
  service: string;
  data: Record<string, unknown>;
  durationMs?: number;
}) => {
  const wsUrl = getHaWsUrl();
  const token = getHaToken();
  const durationMs = input.durationMs ?? 10000;

  return new Promise<{
    ok: boolean;
    events: Array<Record<string, unknown>>;
    states_during: Array<Record<string, unknown>>;
    call_event: Record<string, unknown> | null;
    service_result: { success: boolean; error?: unknown };
  }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let serviceResult: { success: boolean; error?: unknown } = { success: false };
    const events: Array<Record<string, unknown>> = [];
    const statesDuring: Array<Record<string, unknown>> = [];
    let callEvent: Record<string, unknown> | null = null;
    const maxEvents = 200;

    const finish = () => {
      if (settled) return;
      settled = true;
      ws.close();
      resolve({
        ok: serviceResult.success,
        events,
        states_during: statesDuring,
        call_event: callEvent,
        service_result: serviceResult,
      });
    };

    const timeout = setTimeout(() => {
      finish();
    }, durationMs);

    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(err instanceof Error ? err : new Error("WS trace error"));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type?: string;
          id?: number;
          success?: boolean;
          result?: unknown;
          error?: unknown;
          event?: Record<string, unknown>;
        };

        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (msg.type === "auth_invalid") {
          serviceResult = { success: false, error: msg.error ?? "auth_invalid" };
          clearTimeout(timeout);
          finish();
          return;
        }
        if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
          ws.send(JSON.stringify({ id: 2, type: "subscribe_events", event_type: "call_service" }));
          ws.send(
            JSON.stringify({
              id: 3,
              type: "call_service",
              domain: input.domain,
              service: input.service,
              service_data: input.data,
            }),
          );
          return;
        }
        if (msg.id === 3) {
          serviceResult = { success: Boolean(msg.success), error: msg.error };
          return;
        }
        if (msg.type === "event" && msg.event && events.length < maxEvents) {
          const payload = msg.event;
          const eventType = safeString(payload["event_type"]);
          if (eventType === "state_changed") {
            const data = payload["data"] as Record<string, unknown>;
            const entityId = safeString(data?.["entity_id"]);
            if (input.entityIds.includes(entityId)) {
              statesDuring.push(payload);
              events.push(payload);
            }
          } else if (eventType === "call_service") {
            const data = payload["data"] as Record<string, unknown>;
            const domain = safeString(data?.["domain"]);
            const service = safeString(data?.["service"]);
            const serviceData = data?.["service_data"] as Record<string, unknown> | undefined;
            const entityField = serviceData?.["entity_id"];
            const entities = toArray(entityField as string | string[] | undefined);
            if (domain === input.domain && service === input.service) {
              if (input.entityIds.length === 0) {
                events.push(payload);
                callEvent = payload;
              } else if (entities.length === 0 || entities.some((entry) => input.entityIds.includes(entry))) {
                events.push(payload);
                callEvent = payload;
              }
            }
          }
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ws.close();
        reject(err instanceof Error ? err : new Error("WS trace parse error"));
      }
    };
  });
};

const pickEvidenceAttributes = (attrs?: Record<string, unknown>) => {
  if (!attrs) return {};
  const keys = [
    "friendly_name",
    "unit_of_measurement",
    "brightness",
    "color_mode",
    "color_temp_kelvin",
    "current_position",
    "last_triggered",
    "volume_level",
    "source",
    "hvac_mode",
    "preset_mode",
    "temperature",
    "target_temp_low",
    "target_temp_high",
    "percentage",
    "speed",
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (attrs[key] !== undefined) {
      output[key] = attrs[key];
    }
  }
  return output;
};

const buildStateEvidence = (state: HaState | null) =>
  state
    ? {
        state: state.state,
        attributes: pickEvidenceAttributes(state.attributes),
        last_changed: state.last_changed,
      }
    : null;

const buildEntityEvidenceMap = (entityIds: string[], states: Array<HaState | null>) => {
  const evidence: Record<string, unknown> = {};
  entityIds.forEach((entityId, index) => {
    evidence[entityId] = buildStateEvidence(states[index] ?? null);
  });
  return evidence;
};

const buildEventStateEvidence = (event: Record<string, unknown> | null) => {
  if (!event) return { entityId: "", before: null, after: null };
  const data = (event["data"] ?? {}) as Record<string, unknown>;
  const entityId = safeString(data["entity_id"]);
  const oldState = (data["old_state"] ?? null) as HaState | null;
  const newState = (data["new_state"] ?? null) as HaState | null;
  return {
    entityId,
    before: oldState && entityId ? { [entityId]: buildStateEvidence(oldState) } : null,
    after: newState && entityId ? { [entityId]: buildStateEvidence(newState) } : null,
  };
};

const pickStateChangeEvent = (
  events: Array<Record<string, unknown>> | undefined,
  entityIds: string[],
) => {
  if (!events || events.length === 0) return null;
  return (
    events.find((entry) => {
      if (safeString(entry["event_type"]) !== "state_changed") return false;
      const data = (entry["data"] ?? {}) as Record<string, unknown>;
      const entityId = safeString(data["entity_id"]);
      return entityIds.includes(entityId);
    }) ?? null
  );
};

const resolveExpectedState = (domain: string, service: string, payload: Record<string, unknown>) => {
  const normalizedDomain = domain.toLowerCase();
  const normalizedService = service.toLowerCase();
  if (normalizedService === "turn_on") return "on";
  if (normalizedService === "turn_off") return "off";
  if (normalizedDomain === "cover" && normalizedService === "open_cover") return "open";
  if (normalizedDomain === "cover" && normalizedService === "close_cover") return "closed";
  if (normalizedDomain === "input_select" && normalizedService === "select_option") {
    const option = payload["option"];
    if (typeof option === "string" && option.trim()) return option;
  }
  return null;
};

const resolveExpectedNumber = (domain: string, service: string, payload: Record<string, unknown>) => {
  const normalizedDomain = domain.toLowerCase();
  const normalizedService = service.toLowerCase();
  if (normalizedDomain === "input_number" && normalizedService === "set_value") {
    const value = toNumber(payload["value"]);
    return value !== undefined ? value : null;
  }
  return null;
};

const LOW_RISK_VERIFICATION_SEMANTICS = new Set(["light", "fan", "outlet", "generic_switch"]);
const LOW_RISK_VERIFICATION_DOMAINS = new Set(["light", "fan", "switch"]);

const isLowRiskVerificationTarget = (semanticType: string, domain: string) => {
  const normalizedSemantic = normalizeName(semanticType);
  return LOW_RISK_VERIFICATION_SEMANTICS.has(normalizedSemantic) || LOW_RISK_VERIFICATION_DOMAINS.has(domain);
};

const getLowRiskVerifyTimeoutMs = (semanticType: string, domain: string) => {
  const normalizedSemantic = normalizeName(semanticType);
  if (normalizedSemantic === "light" || domain === "light") return 45000;
  if (normalizedSemantic === "fan" || domain === "fan") return 45000;
  if (normalizedSemantic === "outlet" || normalizedSemantic === "generic_switch" || domain === "switch") return 30000;
  return null;
};

const clampTimeout = (value: number, minMs: number, maxMs: number) =>
  Math.max(minMs, Math.min(maxMs, value));

const hasStateChanged = (before: HaState | null, after: HaState | null) => {
  if (!before && after) return true;
  if (before && !after) return true;
  if (!before || !after) return false;
  return before.state !== after.state;
};

const pollForStateVerification = async (input: {
  domain: string;
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<VerificationResult> => {
  const timeoutMs = input.timeoutMs ?? 5000;
  const intervalMs = input.intervalMs ?? 400;
  const beforeStates = await Promise.all(
    input.entityIds.map((entityId) => fetchEntityState(entityId)),
  );
  const beforeEvidence = buildEntityEvidenceMap(input.entityIds, beforeStates);
  const expectedState = resolveExpectedState(input.domain, input.service, input.payload);
  const expectedNumber = resolveExpectedNumber(input.domain, input.service, input.payload);
  const deadline = Date.now() + timeoutMs;
  let afterStates = beforeStates;
  let ok = false;
  let reason = "timeout";

  while (Date.now() < deadline) {
    await waitMs(intervalMs);
    afterStates = await Promise.all(
      input.entityIds.map((entityId) => fetchEntityState(entityId)),
    );
    if (expectedState) {
      const matches = input.entityIds.every((_, index) => afterStates[index]?.state === expectedState);
      if (matches) {
        ok = true;
        reason = "verified";
        break;
      }
    } else if (expectedNumber !== null) {
      const matches = input.entityIds.every((_, index) => {
        const value = toNumber(afterStates[index]?.state);
        return value !== undefined && Math.abs(value - expectedNumber) < 0.001;
      });
      if (matches) {
        ok = true;
        reason = "verified";
        break;
      }
    } else {
      const changed = input.entityIds.some((_, index) =>
        hasStateChanged(beforeStates[index] ?? null, afterStates[index] ?? null),
      );
      if (changed) {
        ok = true;
        reason = "verified";
        break;
      }
    }
  }

  const afterEvidence = buildEntityEvidenceMap(input.entityIds, afterStates);
  return {
    attempted: true,
    ok,
    level: ok ? "state" : "none",
    method: "state_poll",
    reason,
    targets: input.entityIds,
    before: beforeEvidence,
    after: afterEvidence,
  };
};

const pollForAttributeVerification = async (input: {
  entityIds: string[];
  timeoutMs?: number;
  intervalMs?: number;
  describe: (state: HaState | null, entityId: string) => {
    ok: boolean;
    reason: string;
    expected?: unknown;
    observed?: unknown;
  };
}): Promise<VerificationResult> => {
  const timeoutMs = input.timeoutMs ?? 5000;
  const intervalMs = input.intervalMs ?? 400;
  const beforeStates = await Promise.all(
    input.entityIds.map((entityId) => fetchEntityState(entityId)),
  );
  const beforeEvidence = buildEntityEvidenceMap(input.entityIds, beforeStates);
  const deadline = Date.now() + timeoutMs;
  let afterStates = beforeStates;
  let ok = false;
  let reason = "timeout";
  let evidence: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    await waitMs(intervalMs);
    afterStates = await Promise.all(
      input.entityIds.map((entityId) => fetchEntityState(entityId)),
    );
    const perEntity = input.entityIds.map((entityId, index) => {
      const result = input.describe(afterStates[index] ?? null, entityId);
      return { entity_id: entityId, ...result };
    });
    evidence = { matches: perEntity };
    const allOk = perEntity.every((entry) => entry.ok);
    if (allOk) {
      ok = true;
      reason = "verified";
      break;
    }
    const firstFailure = perEntity.find((entry) => !entry.ok);
    if (firstFailure) {
      reason = firstFailure.reason || reason;
    }
  }

  const afterEvidence = buildEntityEvidenceMap(input.entityIds, afterStates);
  return {
    attempted: true,
    ok,
    level: ok ? "state" : "none",
    method: "attribute_check",
    reason,
    targets: input.entityIds,
    before: beforeEvidence,
    after: afterEvidence,
    evidence,
  };
};

const verifyMediaPlayerChange = async (input: {
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  timeoutMs?: number;
}) => {
  const volumeLevel = toNumberLoose(input.payload.volume_level);
  const source = safeString(input.payload.source ?? "");
  if (input.service === "volume_set" && volumeLevel !== undefined) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const level = toNumberLoose(state?.attributes?.["volume_level"]);
        if (level === undefined) {
          return { ok: false, reason: "volume_level_missing", expected: volumeLevel, observed: null };
        }
        const ok = Math.abs(level - volumeLevel) <= 0.02;
        return { ok, reason: ok ? "verified" : "volume_level_mismatch", expected: volumeLevel, observed: level };
      },
    });
  }
  if (input.service === "select_source" && source) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = safeString(state?.attributes?.["source"] ?? "");
        if (!current) {
          return { ok: false, reason: "source_missing", expected: source, observed: null };
        }
        const ok = normalizeName(current) === normalizeName(source);
        return { ok, reason: ok ? "verified" : "source_mismatch", expected: source, observed: current };
      },
    });
  }
  if (["media_play", "media_pause", "media_stop"].includes(input.service)) {
    const expected =
      input.service === "media_play" ? ["playing", "buffering"] : input.service === "media_pause" ? ["paused"] : ["idle", "off"];
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = safeString(state?.state ?? "");
        if (!current) {
          return { ok: false, reason: "state_missing", expected, observed: null };
        }
        const ok = expected.some((value) => normalizeName(value) === normalizeName(current));
        return { ok, reason: ok ? "verified" : "state_mismatch", expected, observed: current };
      },
    });
  }
  return await pollForStateVerification({
    domain: "media_player",
    service: input.service,
    payload: input.payload,
    entityIds: input.entityIds,
    timeoutMs: input.timeoutMs ?? 5000,
    intervalMs: 400,
  });
};

const verifyClimateChange = async (input: {
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  timeoutMs?: number;
}) => {
  const hvacMode = safeString(input.payload.hvac_mode ?? "");
  const presetMode = safeString(input.payload.preset_mode ?? "");
  const temp = toNumberLoose(input.payload.temperature);
  const tempLow = toNumberLoose(input.payload.target_temp_low);
  const tempHigh = toNumberLoose(input.payload.target_temp_high);
  if (input.service === "set_hvac_mode" && hvacMode) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = safeString(state?.attributes?.["hvac_mode"] ?? "");
        if (!current) {
          return { ok: false, reason: "hvac_mode_missing", expected: hvacMode, observed: null };
        }
        const ok = normalizeName(current) === normalizeName(hvacMode);
        return { ok, reason: ok ? "verified" : "hvac_mode_mismatch", expected: hvacMode, observed: current };
      },
    });
  }
  if (input.service === "set_preset_mode" && presetMode) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = safeString(state?.attributes?.["preset_mode"] ?? "");
        if (!current) {
          return { ok: false, reason: "preset_mode_missing", expected: presetMode, observed: null };
        }
        const ok = normalizeName(current) === normalizeName(presetMode);
        return { ok, reason: ok ? "verified" : "preset_mode_mismatch", expected: presetMode, observed: current };
      },
    });
  }
  if (input.service === "set_temperature" && (temp !== undefined || tempLow !== undefined || tempHigh !== undefined)) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const attrs = (state?.attributes ?? {}) as Record<string, unknown>;
        const currentTemp = toNumberLoose(attrs["temperature"]);
        const currentLow = toNumberLoose(attrs["target_temp_low"]);
        const currentHigh = toNumberLoose(attrs["target_temp_high"]);
        if (temp !== undefined) {
          if (currentTemp === undefined) {
            return { ok: false, reason: "temperature_missing", expected: temp, observed: null };
          }
          const ok = Math.abs(currentTemp - temp) < 0.5;
          return { ok, reason: ok ? "verified" : "temperature_mismatch", expected: temp, observed: currentTemp };
        }
        if (tempLow !== undefined || tempHigh !== undefined) {
          const lowOk = tempLow === undefined || (currentLow !== undefined && Math.abs(currentLow - tempLow) < 0.5);
          const highOk =
            tempHigh === undefined || (currentHigh !== undefined && Math.abs(currentHigh - tempHigh) < 0.5);
          const ok = lowOk && highOk;
          return {
            ok,
            reason: ok ? "verified" : "temperature_range_mismatch",
            expected: { target_temp_low: tempLow, target_temp_high: tempHigh },
            observed: { target_temp_low: currentLow, target_temp_high: currentHigh },
          };
        }
        return { ok: false, reason: "temperature_missing", expected: null, observed: null };
      },
    });
  }
  return await pollForStateVerification({
    domain: "climate",
    service: input.service,
    payload: input.payload,
    entityIds: input.entityIds,
    timeoutMs: input.timeoutMs ?? 5000,
    intervalMs: 400,
  });
};

const verifyCoverChange = async (input: {
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  timeoutMs?: number;
}) => {
  const position = toNumberLoose(input.payload.position);
  if (input.service === "set_cover_position" && position !== undefined) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = toNumberLoose(state?.attributes?.["current_position"]);
        if (current === undefined) {
          return { ok: false, reason: "position_missing", expected: position, observed: null };
        }
        const ok = Math.abs(current - position) <= 5;
        return { ok, reason: ok ? "verified" : "position_mismatch", expected: position, observed: current };
      },
    });
  }
  return await pollForStateVerification({
    domain: "cover",
    service: input.service,
    payload: input.payload,
    entityIds: input.entityIds,
    timeoutMs: input.timeoutMs ?? 5000,
    intervalMs: 400,
  });
};

const verifyFanChange = async (input: {
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  timeoutMs?: number;
}) => {
  const percentage = toNumberLoose(input.payload.percentage);
  const presetMode = safeString(input.payload.preset_mode ?? "");
  if (input.service === "set_percentage" && percentage !== undefined) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = toNumberLoose(state?.attributes?.["percentage"]);
        if (current === undefined) {
          return { ok: false, reason: "percentage_missing", expected: percentage, observed: null };
        }
        const ok = Math.abs(current - percentage) <= 5;
        return { ok, reason: ok ? "verified" : "percentage_mismatch", expected: percentage, observed: current };
      },
    });
  }
  if (input.service === "set_preset_mode" && presetMode) {
    return await pollForAttributeVerification({
      entityIds: input.entityIds,
      timeoutMs: input.timeoutMs,
      describe: (state) => {
        const current = safeString(state?.attributes?.["preset_mode"] ?? "");
        if (!current) {
          return { ok: false, reason: "preset_mode_missing", expected: presetMode, observed: null };
        }
        const ok = normalizeName(current) === normalizeName(presetMode);
        return { ok, reason: ok ? "verified" : "preset_mode_mismatch", expected: presetMode, observed: current };
      },
    });
  }
  return await pollForStateVerification({
    domain: "fan",
    service: input.service,
    payload: input.payload,
    entityIds: input.entityIds,
    timeoutMs: input.timeoutMs ?? 5000,
    intervalMs: 400,
  });
};

const buildEmptyVerification = (reason: string, targets: string[] = []): VerificationResult => ({
  attempted: false,
  ok: false,
  level: "none",
  method: "none",
  reason,
  targets,
  before: null,
  after: null,
});

const executeServiceCallWithVerification = async (input: {
  domain: string;
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  normalizationFallback?: Record<string, unknown> | null;
  verifyTimeoutMs?: number;
  wsTimeoutMs?: number;
  allowEventVerification?: boolean;
}) => {
  let verification: VerificationResult = buildEmptyVerification("not_verifiable", input.entityIds);
  let res: { ok: boolean; status?: number; data?: unknown; bytes: number };
  if (input.domain === "persistent_notification" && input.service === "create") {
    const notificationId = safeString(input.payload["notification_id"]);
    const wsTrace = await wsTraceServiceCommand({
      entityIds: [],
      domain: input.domain,
      service: input.service,
      data: input.payload,
      durationMs: input.wsTimeoutMs ?? 5000,
    });
    res = {
      ok: wsTrace.ok,
      status: wsTrace.ok ? 200 : undefined,
      data: wsTrace.service_result,
      bytes: Buffer.byteLength(JSON.stringify(wsTrace.service_result ?? {}), "utf8"),
    };
    const matchingEvent = wsTrace.events.find((entry) => {
      const payload = entry["data"] as Record<string, unknown>;
      const eventDomain = safeString(payload?.["domain"]);
      const eventService = safeString(payload?.["service"]);
      if (eventDomain !== "persistent_notification" || eventService !== "create") return false;
      if (!notificationId) return true;
      const serviceData = payload?.["service_data"] as Record<string, unknown> | undefined;
      return safeString(serviceData?.["notification_id"]) === notificationId;
    });
    verification = {
      attempted: true,
      ok: Boolean(matchingEvent),
      level: matchingEvent ? "ha_event" : "none",
      method: "ws_event",
      reason: matchingEvent ? "verified" : "timeout",
      targets: [],
      before: null,
      after: null,
      evidence: matchingEvent
        ? {
            event_type: safeString(matchingEvent["event_type"]),
            time_fired: safeString(matchingEvent["time_fired"]),
            domain: safeString(
              (matchingEvent["data"] as Record<string, unknown> | undefined)?.["domain"],
            ),
            service: safeString(
              (matchingEvent["data"] as Record<string, unknown> | undefined)?.["service"],
            ),
            notification_id: safeString(
              ((matchingEvent["data"] as Record<string, unknown> | undefined)?.["service_data"] as
                | Record<string, unknown>
                | undefined)?.["notification_id"],
            ),
          }
        : null,
    };
    return { res, verification };
  }

  const trace = await wsTraceServiceCommand({
    entityIds: input.entityIds,
    domain: input.domain,
    service: input.service,
    data: input.payload,
    durationMs: input.wsTimeoutMs ?? 8000,
  });
  const callEvent = trace.call_event as Record<string, unknown> | null;
  const stateEvent = input.allowEventVerification
    ? pickStateChangeEvent(trace.states_during, input.entityIds)
    : null;
  const stateEventEvidence = stateEvent ? buildEventStateEvidence(stateEvent) : null;
  res = {
    ok: trace.ok,
    status: trace.ok ? 200 : undefined,
    data: trace.service_result,
    bytes: Buffer.byteLength(JSON.stringify(trace.service_result ?? {}), "utf8"),
  };
  if (res.ok && input.entityIds.length > 0) {
    if (stateEvent && stateEventEvidence) {
      verification = {
        attempted: true,
        ok: true,
        level: "state",
        method: "ws_event",
        reason: "verified_state_event",
        targets: input.entityIds,
        before: stateEventEvidence.before,
        after: stateEventEvidence.after,
        evidence: {
          ws_state_event: stateEvent,
          ws_call_service: callEvent ?? null,
          ws_state_events: trace.states_during ?? [],
          applied_fallbacks: buildAppliedFallbacks([], input.normalizationFallback ?? null),
        },
      };
    } else if (input.allowEventVerification && callEvent) {
      verification = {
        attempted: true,
        ok: true,
        level: "ha_event",
        method: "ws_event",
        reason: "verified_call_event",
        targets: input.entityIds,
        before: null,
        after: null,
        evidence: {
          ws_call_service: callEvent ?? null,
          ws_state_events: trace.states_during ?? [],
          applied_fallbacks: buildAppliedFallbacks([], input.normalizationFallback ?? null),
        },
      };
    } else if (input.domain === "media_player") {
      verification = await verifyMediaPlayerChange({
        service: input.service,
        payload: input.payload,
        entityIds: input.entityIds,
        timeoutMs: input.verifyTimeoutMs,
      });
    } else if (input.domain === "climate") {
      verification = await verifyClimateChange({
        service: input.service,
        payload: input.payload,
        entityIds: input.entityIds,
        timeoutMs: input.verifyTimeoutMs,
      });
    } else if (input.domain === "cover") {
      verification = await verifyCoverChange({
        service: input.service,
        payload: input.payload,
        entityIds: input.entityIds,
        timeoutMs: input.verifyTimeoutMs,
      });
    } else if (input.domain === "fan") {
      verification = await verifyFanChange({
        service: input.service,
        payload: input.payload,
        entityIds: input.entityIds,
        timeoutMs: input.verifyTimeoutMs,
      });
    } else {
      verification = await pollForStateVerification({
        domain: input.domain,
        service: input.service,
        payload: input.payload,
        entityIds: input.entityIds,
        timeoutMs: input.verifyTimeoutMs ?? 5000,
        intervalMs: 400,
      });
    }
  }
  if (verification.attempted) {
    if (!verification.ok && input.allowEventVerification && callEvent) {
      verification = {
        attempted: true,
        ok: true,
        level: "ha_event",
        method: "ws_event",
        reason: "verified_call_event",
        targets: input.entityIds,
        before: verification.before,
        after: verification.after,
        evidence: {
          ...(verification.evidence ?? {}),
          ws_call_service: callEvent ?? null,
          ws_state_events: trace.states_during ?? [],
        },
      };
    }
    const resolvedLevel =
      verification.level && verification.level !== "none"
        ? verification.level
        : verification.ok
          ? "state"
          : callEvent
            ? "ha_event"
            : "none";
    verification = {
      ...verification,
      level: resolvedLevel,
      evidence: {
        ...(verification.evidence ?? {}),
        ws_call_service: callEvent ?? null,
        ws_state_events: trace.states_during ?? [],
        applied_fallbacks: buildAppliedFallbacks([], input.normalizationFallback ?? null),
      },
    };
  } else if (!res.ok) {
    verification = {
      attempted: true,
      ok: false,
      level: trace.call_event ? "ha_event" : "none",
      method: "ws_event",
      reason: "service_failed",
      targets: input.entityIds,
      before: null,
      after: null,
      evidence: {
        ws_call_service: trace.call_event ?? null,
        ws_state_events: trace.states_during ?? [],
      },
    };
  }
  return { res, verification };
};

const buildAppliedFallbacks = (
  warnings: string[],
  normalizationFallback: Record<string, unknown> | null,
) => {
  const entries: Array<Record<string, unknown>> = [];
  if (normalizationFallback) entries.push(normalizationFallback);
  if (warnings.includes("color_to_color_temp_fallback")) {
    entries.push({ reason: "color_to_color_temp_fallback" });
  }
  const colorFallback = warnings.find((entry) => entry.startsWith("color_mode_fallback"));
  if (colorFallback) {
    entries.push({ reason: colorFallback });
  }
  return entries;
};

const callServiceWithEventVerification = async (input: {
  domain: string;
  service: string;
  payload: Record<string, unknown>;
  eventType: string;
  timeoutMs?: number;
  matchEvent?: (payload: Record<string, unknown>) => boolean;
}) => {
  const wsUrl = getHaWsUrl();
  const token = getHaToken();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<{
    res: { ok: boolean; status?: number; data?: unknown; bytes: number };
    event: Record<string, unknown> | null;
    eventReceived: boolean;
  }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let eventReceived = false;
    let eventPayload: Record<string, unknown> | null = null;
    let actionDone = false;
    let eventDone = false;
    let subscriptionReady = false;
    let actionStarted = false;
    let actionResult: { ok: boolean; status?: number; data?: unknown; bytes: number } = {
      ok: false,
      bytes: 0,
    };

    const finish = () => {
      if (settled) return;
      if (!actionDone || !eventDone) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      resolve({ res: actionResult, event: eventPayload, eventReceived });
    };

    const timeout = setTimeout(() => {
      eventDone = true;
      finish();
    }, timeoutMs);

    ws.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(err instanceof Error ? err : new Error("WS event error"));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type?: string;
          id?: number;
          success?: boolean;
          result?: unknown;
          error?: unknown;
          event?: Record<string, unknown>;
        };
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (msg.type === "auth_invalid") {
          eventDone = true;
          actionDone = true;
          actionResult = { ok: false, bytes: 0, data: msg.error };
          finish();
          return;
        }
        if (msg.type === "auth_ok") {
          const subscribePayload: Record<string, unknown> = { id: 1, type: "subscribe_events" };
          if (input.eventType !== "all") {
            subscribePayload.event_type = input.eventType;
          }
          ws.send(JSON.stringify(subscribePayload));
          return;
        }
        if (msg.id === 1 && msg.success && !subscriptionReady) {
          subscriptionReady = true;
        }
        if (subscriptionReady && !actionStarted) {
          actionStarted = true;
          Promise.resolve()
            .then(async () => {
              const baseUrl = getHaBaseUrl();
              const res = await requestJson({
                method: "POST",
                url: `${baseUrl}/api/services/${input.domain}/${input.service}`,
                token,
                body: input.payload,
              });
              actionResult = res;
            })
            .catch((err) => {
              actionResult = { ok: false, bytes: 0, data: err };
            })
            .finally(() => {
              actionDone = true;
              if (!actionResult.ok) {
                eventDone = true;
              }
              finish();
            });
        }
        if (msg.type === "event" && msg.event) {
          const payload = msg.event;
          const eventType = safeString(payload["event_type"]);
          const typeMatches = input.eventType === "all" ? Boolean(eventType) : eventType === input.eventType;
          if (typeMatches && (!input.matchEvent || input.matchEvent(payload))) {
            eventReceived = true;
            eventPayload = payload;
            eventDone = true;
            finish();
          }
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ws.close();
        reject(err instanceof Error ? err : new Error("WS event parse error"));
      }
    };
  });
};

const buildServicePayload = (target?: Record<string, unknown>, data?: Record<string, unknown>) => {
  const payload: Record<string, unknown> = {};
  if (data) Object.assign(payload, data);
  if (target) {
    if ("entity_id" in target) payload.entity_id = target.entity_id;
    if ("device_id" in target) payload.device_id = target.device_id;
    if ("area_id" in target) payload.area_id = target.area_id;
  }
  return payload;
};

const replacePayload = (target: Record<string, unknown>, replacement: Record<string, unknown>) => {
  for (const key of Object.keys(target)) {
    if (!(key in replacement)) delete target[key];
  }
  Object.assign(target, replacement);
};

const normalizeServiceCallAction = (action: Record<string, unknown>) => {
  const domain = String(action["domain"] ?? "");
  const service = String(action["service"] ?? "");
  const payload = buildServicePayload(
    (action["target"] ?? {}) as Record<string, unknown>,
    (action["data"] ?? {}) as Record<string, unknown>,
  );
  const serviceData = (action["service_data"] ?? {}) as Record<string, unknown>;
  Object.assign(payload, serviceData);
  if (action["entity_id"]) {
    payload.entity_id = action["entity_id"];
  }
  return { domain, service, data: payload };
};

const listEntitiesFiltered = (entities: HaState[], domain?: string, contains?: string) => {
  const lowerContains = contains?.toLowerCase();
  return entities
    .filter((entity) => {
      if (domain && !entity.entity_id.startsWith(`${domain}.`)) return false;
      if (!lowerContains) return true;
      const friendlyName = String(entity.attributes?.["friendly_name"] ?? "").toLowerCase();
      return (
        entity.entity_id.toLowerCase().includes(lowerContains) ||
        friendlyName.includes(lowerContains)
      );
    })
    .map((entity) => ({
      entity_id: entity.entity_id,
      friendly_name: String(entity.attributes?.["friendly_name"] ?? ""),
      state: entity.state,
    }));
};

const listEntitiesByDomains = (entities: HaState[], domains: string[]) =>
  entities
    .filter((entity) => domains.some((domain) => entity.entity_id.startsWith(`${domain}.`)))
    .map((entity) => ({
      entity_id: entity.entity_id,
      friendly_name: String(entity.attributes?.["friendly_name"] ?? ""),
      state: entity.state,
      domain: entity.entity_id.split(".")[0] ?? "",
    }));

const normalizeName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const COLOR_NAME_MAP: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  purple: [128, 0, 128],
  violet: [138, 43, 226],
  magenta: [255, 0, 255],
  pink: [255, 105, 180],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  white: [255, 255, 255],
  teal: [0, 128, 128],
  cyan: [0, 255, 255],
};

const parseHexColor = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const match = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  if (!/^[0-9a-f]{6}$/.test(match)) return undefined;
  const r = parseInt(match.slice(0, 2), 16);
  const g = parseInt(match.slice(2, 4), 16);
  const b = parseInt(match.slice(4, 6), 16);
  return [r, g, b] as [number, number, number];
};

const parseRgbString = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const rgbMatch = normalized.match(/rgb\(([^)]+)\)/);
  const raw = rgbMatch ? rgbMatch[1] : normalized;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 3) return undefined;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isFinite(num))) return undefined;
  return nums.map((num) => clampNumber(Math.round(num), 0, 255)) as [number, number, number];
};

const parseColorToRgb = (value: string) => {
  const hex = parseHexColor(value);
  if (hex) return hex;
  const rgb = parseRgbString(value);
  if (rgb) return rgb;
  const normalized = normalizeName(value);
  if (!normalized) return undefined;
  if (normalized.includes("ljubicast")) {
    return [128, 0, 128];
  }
  return COLOR_NAME_MAP[normalized];
};

const rgbToHs = (rgb: [number, number, number]) => {
  const [r, g, b] = rgb.map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : (delta / max) * 100;
  return [Math.round(h), Math.round(s)] as [number, number];
};

const hsToRgb = (hs: [number, number]) => {
  const [h, s] = hs;
  const sat = clampNumber(s, 0, 100) / 100;
  const v = 1;
  const c = v * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h >= 0 && h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ] as [number, number, number];
};

const rgbToXy = (rgb: [number, number, number]) => {
  const [rRaw, gRaw, bRaw] = rgb.map((value) => value / 255);
  const r = rRaw > 0.04045 ? Math.pow((rRaw + 0.055) / 1.055, 2.4) : rRaw / 12.92;
  const g = gRaw > 0.04045 ? Math.pow((gRaw + 0.055) / 1.055, 2.4) : gRaw / 12.92;
  const b = bRaw > 0.04045 ? Math.pow((bRaw + 0.055) / 1.055, 2.4) : bRaw / 12.92;
  const x = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = x + y + z;
  if (sum === 0) return [0, 0];
  return [Number((x / sum).toFixed(4)), Number((y / sum).toFixed(4))] as [number, number];
};

const xyToRgb = (xy: [number, number]) => {
  const [x, y] = xy;
  if (y === 0) return [0, 0, 0];
  const z = 1.0 - x - y;
  const Y = 1.0;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
  g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
  b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;
  return [
    clampNumber(Math.round(r * 255), 0, 255),
    clampNumber(Math.round(g * 255), 0, 255),
    clampNumber(Math.round(b * 255), 0, 255),
  ] as [number, number, number];
};

const nowMinusMinutes = (minutes: number) => {
  const ms = Math.max(0, minutes) * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
};

const buildTimeContext = async (input: {
  minutes?: number;
  start_time?: string;
  end_time?: string;
}) => {
  const tz = await getHaTimeZone();
  const now = new Date();
  const startRaw =
    input.start_time ?? (input.minutes !== undefined ? nowMinusMinutes(input.minutes) : undefined);
  if (!startRaw) {
    throw new Error("time_context requires minutes or start_time");
  }
  const startDate = parseDateValue(startRaw);
  if (!startDate) {
    throw new Error("time_context invalid start_time");
  }
  const endDate = parseDateValue(input.end_time) ?? now;
  const nowUtc = now.toISOString();
  const startUtc = startDate.toISOString();
  const endUtc = endDate.toISOString();
  return {
    tz,
    now_utc: nowUtc,
    now_local: formatLocalTimeSafe(now, tz),
    range_utc: { start: startUtc, end: endUtc },
    range_local: {
      start: formatLocalTimeSafe(startDate, tz),
      end: formatLocalTimeSafe(endDate, tz),
    },
    start_date: startDate,
    end_date: endDate,
  };
};

const toArray = (value?: string | string[]) => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const toNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toNumberLoose = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const cleaned = normalized.replace(/[^0-9.+-]/g, "");
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toNumberArray = (value: unknown, length: number) => {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const nums = value.map((entry) => toNumber(entry));
  if (nums.some((entry) => entry === undefined)) return undefined;
  return nums as number[];
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const parsePercentValue = (value: unknown) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(value, 0, 100);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const cleaned = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return undefined;
    return clampNumber(parsed, 0, 100);
  }
  return undefined;
};

const parseDateValue = (value?: string) => {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts) : null;
};

const fetchEntityState = async (entityId: string) => {
  const wsRes = await fetchStatesWs();
  if (wsRes.ok && Array.isArray(wsRes.data)) {
    const found = wsRes.data.find((state) => state.entity_id === entityId);
    if (found) return found;
  }
  const baseUrl = getHaBaseUrl();
  const token = getHaToken();
  const res = await requestJson({
    method: "GET",
    url: `${baseUrl}/api/states/${entityId}`,
    token,
  });
  if (!res.ok || !res.data || typeof res.data !== "object") {
    return null;
  }
  return res.data as HaState;
};

const fetchHistoryPeriod = async (entityIds: string[], startTime: string, endTime: string) => {
  const baseUrl = getHaBaseUrl();
  const token = getHaToken();
  const query = new URLSearchParams({
    end_time: endTime,
    minimal_response: "1",
  });
  if (entityIds.length > 0) {
    query.set("filter_entity_id", entityIds.join(","));
  }
  return await requestJson({
    method: "GET",
    url: `${baseUrl}/api/history/period/${encodeURIComponent(startTime)}?${query.toString()}`,
    token,
  });
};

const getServiceFields = (
  services: HaServices | null,
  domain: string,
  service: string,
): Record<string, HaServiceField> => {
  const entry = services?.[domain]?.[service];
  if (!entry || typeof entry !== "object") return {};
  return entry.fields ?? {};
};

type LightColorExpected = {
  mode: "hs" | "xy" | "rgb" | "rgbw" | "rgbww";
  value: number[];
  name?: string;
};

type LightExpected = {
  state?: "on" | "off";
  brightness?: number;
  brightness_pct?: number;
  color_temp?: number;
  color_temp_kelvin?: number;
  color?: LightColorExpected;
};

type LightCapabilities = {
  supported_color_modes: string[];
  supports_brightness: boolean;
  supports_color_temp: boolean;
  supports_color: boolean;
};

type LightRequest = {
  brightness_pct?: number;
  brightness?: number;
  color_temp_kelvin?: number;
  kelvin?: number;
  color_temp?: number;
  color_name?: string;
  color?: string;
  hs_color?: number[];
  xy_color?: number[];
  rgb_color?: number[];
  rgbw_color?: number[];
  rgbww_color?: number[];
};

const extractLightRequest = (payload: Record<string, unknown>): LightRequest => ({
  brightness_pct: parsePercentValue(payload.brightness_pct),
  brightness: toNumberLoose(payload.brightness),
  color_temp_kelvin: toNumberLoose(payload.color_temp_kelvin),
  kelvin: toNumberLoose(payload.kelvin),
  color_temp: toNumberLoose(payload.color_temp),
  color_name: safeString(payload.color_name),
  color: safeString(payload.color),
  hs_color: toNumberArray(payload.hs_color, 2),
  xy_color: toNumberArray(payload.xy_color, 2),
  rgb_color:
    toNumberArray(payload.rgb_color, 3) ??
    (typeof payload.rgb_color === "string" ? parseRgbString(payload.rgb_color) : undefined),
  rgbw_color: toNumberArray(payload.rgbw_color, 4),
  rgbww_color: toNumberArray(payload.rgbww_color, 5),
});

const extractSupportedColorModes = (state: HaState | null) =>
  Array.isArray(state?.attributes?.["supported_color_modes"])
    ? (state?.attributes?.["supported_color_modes"] as string[])
    : [];

const buildLightCapabilities = (state: HaState | null): LightCapabilities => {
  const supported = extractSupportedColorModes(state);
  const hasBrightnessAttr = state?.attributes?.["brightness"] !== undefined;
  const hasColorTempAttr =
    state?.attributes?.["color_temp"] !== undefined ||
    state?.attributes?.["color_temp_kelvin"] !== undefined ||
    state?.attributes?.["min_mireds"] !== undefined ||
    state?.attributes?.["min_color_temp_kelvin"] !== undefined;
  const supportsColor = supported.some((mode) =>
    ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(mode),
  );
  return {
    supported_color_modes: supported,
    supports_brightness: hasBrightnessAttr || supported.some((mode) => mode !== "onoff"),
    supports_color_temp: hasColorTempAttr || supported.includes("color_temp"),
    supports_color: supportsColor,
  };
};

const normalizeLightTurnOnPayload = (
  payload: Record<string, unknown>,
  fields: Record<string, HaServiceField>,
  capabilities: LightCapabilities,
  request: LightRequest,
) => {
  const supported = new Set(Object.keys(fields ?? {}));
  const normalized = { ...payload };
  const warnings: string[] = [];
  const deprecated: string[] = [];
  const deprecated_notes: string[] = [];
  const unsupported: string[] = [];
  const expected: LightExpected = {};

  let brightnessPct = request.brightness_pct;
  let brightness = request.brightness;
  if (brightnessPct === undefined && brightness !== undefined && brightness >= 0 && brightness <= 100) {
    brightnessPct = brightness;
    brightness = undefined;
  }
  if (brightnessPct !== undefined) {
    expected.brightness_pct = brightnessPct;
    expected.brightness = Math.round((brightnessPct / 100) * 255);
    if (!capabilities.supports_brightness) {
      delete normalized.brightness_pct;
      unsupported.push("brightness");
    } else if (supported.has("brightness_pct")) {
      normalized.brightness_pct = brightnessPct;
      delete normalized.brightness;
    } else if (supported.has("brightness")) {
      normalized.brightness = expected.brightness;
      delete normalized.brightness_pct;
    } else {
      delete normalized.brightness_pct;
      warnings.push("brightness_pct not supported");
    }
  }
  if (brightness !== undefined) {
    expected.brightness = brightness;
    expected.brightness_pct = Math.round((brightness / 255) * 100);
    if (!capabilities.supports_brightness) {
      delete normalized.brightness;
      unsupported.push("brightness");
    } else if (supported.has("brightness")) {
      normalized.brightness = brightness;
      delete normalized.brightness_pct;
    } else if (supported.has("brightness_pct")) {
      normalized.brightness_pct = expected.brightness_pct;
      delete normalized.brightness;
    } else {
      delete normalized.brightness;
      warnings.push("brightness not supported");
    }
  }

  const kelvin = request.color_temp_kelvin ?? request.kelvin;
  const mired = request.color_temp;
  if (kelvin !== undefined || mired !== undefined) {
    const resolvedKelvin = kelvin ?? (mired ? Math.round(1000000 / mired) : undefined);
    const resolvedMired = mired ?? (kelvin ? Math.round(1000000 / kelvin) : undefined);
    if (resolvedKelvin !== undefined) {
      expected.color_temp_kelvin = resolvedKelvin;
      expected.color_temp = resolvedMired;
    }
    if (!capabilities.supports_color_temp) {
      delete normalized.color_temp_kelvin;
      delete normalized.kelvin;
      delete normalized.color_temp;
      unsupported.push("color_temp");
    } else if (supported.has("color_temp_kelvin") && resolvedKelvin !== undefined) {
      normalized.color_temp_kelvin = resolvedKelvin;
      delete normalized.kelvin;
      delete normalized.color_temp;
      if (request.kelvin !== undefined) {
        deprecated.push("kelvin");
        deprecated_notes.push("kelvin provided; converted to color_temp_kelvin");
      }
      if (request.color_temp !== undefined) {
        deprecated.push("color_temp");
        deprecated_notes.push("color_temp (mireds) provided; converted to color_temp_kelvin");
      }
    } else if (supported.has("color_temp") && resolvedMired !== undefined) {
      normalized.color_temp = resolvedMired;
      delete normalized.color_temp_kelvin;
      delete normalized.kelvin;
      deprecated.push("color_temp");
      if (request.color_temp_kelvin !== undefined || request.kelvin !== undefined) {
        deprecated_notes.push("color_temp (mireds) used because service lacks color_temp_kelvin");
      } else {
        deprecated_notes.push("color_temp (mireds) is deprecated; service lacks color_temp_kelvin");
      }
    } else if (supported.has("kelvin") && resolvedKelvin !== undefined) {
      normalized.kelvin = resolvedKelvin;
      delete normalized.color_temp;
      delete normalized.color_temp_kelvin;
      deprecated.push("kelvin");
      deprecated_notes.push("kelvin used because service lacks color_temp_kelvin and color_temp");
    } else {
      delete normalized.color_temp;
      delete normalized.color_temp_kelvin;
      delete normalized.kelvin;
      warnings.push("color_temp not supported by service");
    }
  }

  return { normalized, warnings, expected, deprecated, deprecated_notes, unsupported };
};

const resolveRequestedColor = (request: LightRequest) => {
  if (request.hs_color) return { mode: "hs" as const, value: request.hs_color };
  if (request.xy_color) return { mode: "xy" as const, value: request.xy_color };
  if (request.rgb_color) return { mode: "rgb" as const, value: request.rgb_color };
  if (request.rgbw_color) return { mode: "rgbw" as const, value: request.rgbw_color };
  if (request.rgbww_color) return { mode: "rgbww" as const, value: request.rgbww_color };
  const colorValue = safeString(request.color_name ?? request.color ?? "");
  if (!colorValue) return null;
  const rgb = parseColorToRgb(colorValue);
  if (rgb) return { mode: "rgb" as const, value: rgb, name: colorValue };
  return { mode: "name" as const, value: colorValue };
};

const pickBestColorMode = (supportedModes: string[]) => {
  if (supportedModes.includes("hs")) return "hs";
  if (supportedModes.includes("xy")) return "xy";
  if (supportedModes.includes("rgb")) return "rgb";
  if (supportedModes.includes("rgbw")) return "rgbw";
  if (supportedModes.includes("rgbww")) return "rgbww";
  return null;
};

const applyRequestedColor = (input: {
  payload: Record<string, unknown>;
  request: LightRequest;
  capabilities: LightCapabilities;
}) => {
  const updated = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const unverifiable: string[] = [];
  const requested = resolveRequestedColor(input.request);
  if (!requested) {
    return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: false };
  }
  if (!input.capabilities.supports_color) {
    delete updated.color_name;
    delete updated.color;
    delete updated.hs_color;
    delete updated.xy_color;
    delete updated.rgb_color;
    delete updated.rgbw_color;
    delete updated.rgbww_color;
    if (input.capabilities.supports_color_temp) {
      const fallbackKelvin = 4000;
      if (updated.color_temp_kelvin === undefined && updated.color_temp === undefined) {
        updated.color_temp_kelvin = fallbackKelvin;
      }
      warnings.push("color_to_color_temp_fallback");
      return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: true };
    }
    unsupported.push("color");
    return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: true };
  }

  delete updated.color_name;
  delete updated.color;
  delete updated.hs_color;
  delete updated.xy_color;
  delete updated.rgb_color;
  delete updated.rgbw_color;
  delete updated.rgbww_color;

  if (requested.mode === "name") {
    warnings.push("color_name_unverifiable");
    unverifiable.push("color");
    delete updated.color_name;
    delete updated.color;
    return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: true };
  }

  const bestMode = pickBestColorMode(input.capabilities.supported_color_modes);
  if (!bestMode) {
    unsupported.push("color");
    delete updated.color_name;
    delete updated.color;
    return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: true };
  }

  let rgb: [number, number, number] | null = null;
  if (requested.mode === "rgb") {
    rgb = requested.value as [number, number, number];
  } else if (requested.mode === "hs") {
    rgb = hsToRgb(requested.value as [number, number]);
  } else if (requested.mode === "xy") {
    rgb = xyToRgb(requested.value as [number, number]);
  } else if (requested.mode === "rgbw" || requested.mode === "rgbww") {
    const base = requested.value as number[];
    rgb = [base[0], base[1], base[2]];
  }

  if (!rgb) {
    unsupported.push("color");
    return { payload: updated, expectedColor: undefined, warnings, unsupported, unverifiable, colorRequested: true };
  }

  if (bestMode !== requested.mode) {
    warnings.push(`color_mode_fallback:${requested.mode}->${bestMode}`);
  }

  if (bestMode === "hs") {
    const hs = rgbToHs(rgb);
    updated.hs_color = hs;
    return {
      payload: updated,
      expectedColor: { mode: "hs", value: hs, name: requested.name },
      warnings,
      unsupported,
      unverifiable,
      colorRequested: true,
    };
  }
  if (bestMode === "xy") {
    const xy = rgbToXy(rgb);
    updated.xy_color = xy;
    return {
      payload: updated,
      expectedColor: { mode: "xy", value: xy, name: requested.name },
      warnings,
      unsupported,
      unverifiable,
      colorRequested: true,
    };
  }
  if (bestMode === "rgb") {
    updated.rgb_color = rgb;
    return {
      payload: updated,
      expectedColor: { mode: "rgb", value: rgb, name: requested.name },
      warnings,
      unsupported,
      unverifiable,
      colorRequested: true,
    };
  }
  if (bestMode === "rgbw") {
    updated.rgbw_color = [rgb[0], rgb[1], rgb[2], 0];
    return {
      payload: updated,
      expectedColor: { mode: "rgbw", value: [rgb[0], rgb[1], rgb[2], 0], name: requested.name },
      warnings,
      unsupported,
      unverifiable,
      colorRequested: true,
    };
  }
  updated.rgbww_color = [rgb[0], rgb[1], rgb[2], 0, 0];
  return {
    payload: updated,
    expectedColor: { mode: "rgbww", value: [rgb[0], rgb[1], rgb[2], 0, 0], name: requested.name },
    warnings,
    unsupported,
    unverifiable,
    colorRequested: true,
  };
};

const extractLightEvidence = (state: HaState | null) => {
  const attributes = (state?.attributes ?? {}) as Record<string, unknown>;
  return {
    state: state?.state ?? null,
    attributes: {
      brightness: toNumber(attributes["brightness"]) ?? null,
      color_temp: toNumber(attributes["color_temp"]) ?? null,
      color_temp_kelvin: toNumber(attributes["color_temp_kelvin"]) ?? null,
      color_mode: safeString(attributes["color_mode"]) || null,
      supported_color_modes: Array.isArray(attributes["supported_color_modes"])
        ? (attributes["supported_color_modes"] as string[])
        : [],
      hs_color: toNumberArray(attributes["hs_color"], 2) ?? null,
      xy_color: toNumberArray(attributes["xy_color"], 2) ?? null,
      rgb_color: toNumberArray(attributes["rgb_color"], 3) ?? null,
    },
  };
};

const compareColor = (expected: LightColorExpected, observed: ReturnType<typeof extractLightEvidence>) => {
  const attrs = observed.attributes;
  const colorMode = attrs.color_mode;
  if (!colorMode) {
    return { ok: false, reason: "color_mode_missing" };
  }
  const modeOk =
    expected.mode === "rgb"
      ? ["rgb", "rgbw", "rgbww"].includes(colorMode)
      : expected.mode === colorMode;
  if (!modeOk) {
    return { ok: false, reason: "color_mode_mismatch" };
  }
  if (expected.mode === "hs") {
    const actual = attrs.hs_color;
    if (!actual) return { ok: false, reason: "hs_color_missing" };
    const [h, s] = actual;
    const [eh, es] = expected.value;
    const ok = Math.abs(h - eh) <= 10 && Math.abs(s - es) <= 10;
    return { ok, reason: ok ? null : "hs_color_mismatch" };
  }
  if (expected.mode === "xy") {
    const actual = attrs.xy_color;
    if (!actual) return { ok: false, reason: "xy_color_missing" };
    const [x, y] = actual;
    const [ex, ey] = expected.value;
    const ok = Math.abs(x - ex) <= 0.05 && Math.abs(y - ey) <= 0.05;
    return { ok, reason: ok ? null : "xy_color_mismatch" };
  }
  if (expected.mode === "rgb") {
    const actual = attrs.rgb_color;
    if (!actual) return { ok: false, reason: "rgb_color_missing" };
    const ok = actual.every((val, idx) => Math.abs(val - expected.value[idx]) <= 25);
    return { ok, reason: ok ? null : "rgb_color_mismatch" };
  }
  return { ok: false, reason: "color_mode_unverifiable" };
};

const buildLightMismatches = (input: {
  entity_id: string;
  expected: LightExpected;
  observed: ReturnType<typeof extractLightEvidence>;
  capabilities: LightCapabilities;
  unsupported: string[];
}) => {
  const mismatches: string[] = [];
  const prefix = `${input.entity_id}:`;
  if (input.unsupported.includes("brightness") && input.expected.brightness !== undefined) {
    mismatches.push(`${prefix}brightness_unsupported`);
  }
  if (input.unsupported.includes("color_temp") && input.expected.color_temp_kelvin !== undefined) {
    mismatches.push(`${prefix}color_temp_unsupported`);
  }
  if (input.unsupported.includes("color") && input.expected.color) {
    mismatches.push(`${prefix}color_unsupported`);
  }

  if (input.expected.state && input.observed.state !== input.expected.state) {
    mismatches.push(`${prefix}state_mismatch`);
  }

  if (input.expected.brightness !== undefined) {
    const actual = input.observed.attributes.brightness;
    if (actual === null) {
      mismatches.push(`${prefix}brightness_not_reported`);
    } else if (Math.abs(actual - input.expected.brightness) > 10) {
      mismatches.push(`${prefix}brightness_mismatch`);
    }
  }

  if (input.expected.color_temp_kelvin !== undefined) {
    const actualKelvin = input.observed.attributes.color_temp_kelvin;
    const actualMired = input.observed.attributes.color_temp;
    if (actualKelvin === null && actualMired === null) {
      mismatches.push(`${prefix}color_temp_not_reported`);
    } else if (actualKelvin !== null) {
      if (Math.abs(actualKelvin - input.expected.color_temp_kelvin) > 150) {
        mismatches.push(`${prefix}color_temp_kelvin_mismatch`);
      }
    } else if (actualMired !== null && input.expected.color_temp !== undefined) {
      if (Math.abs(actualMired - input.expected.color_temp) > 15) {
        mismatches.push(`${prefix}color_temp_mismatch`);
      }
    }
  }

  if (input.expected.color) {
    if (!input.capabilities.supports_color) {
      mismatches.push(`${prefix}color_unsupported`);
    } else {
      const comparison = compareColor(input.expected.color, input.observed);
      if (!comparison.ok) {
        const reason = comparison.reason ?? "color_mismatch";
        if (reason === "color_mode_unverifiable") {
          mismatches.push(`${prefix}color_unverifiable`);
        } else if (reason === "color_mode_mismatch") {
          mismatches.push(`${prefix}color_mode_mismatch`);
        } else if (reason.endsWith("_missing")) {
          mismatches.push(`${prefix}color_not_reported`);
        } else {
          mismatches.push(`${prefix}color_mismatch`);
        }
      }
    }
  }

  return mismatches;
};

const buildLightEvidenceMap = (entityIds: string[], states: Array<HaState | null>) => {
  const map: Record<string, ReturnType<typeof extractLightEvidence>> = {};
  entityIds.forEach((entityId, index) => {
    map[entityId] = extractLightEvidence(states[index] ?? null);
  });
  return map;
};

const buildLightEvidenceLine = (entityId: string, observed: ReturnType<typeof extractLightEvidence>) => {
  const attrs = observed.attributes;
  const parts = [
    `state_after_5s[\"${entityId}\"].state=${observed.state ?? "null"}`,
    `state_after_5s[\"${entityId}\"].attributes.brightness=${attrs.brightness ?? "null"}`,
    `state_after_5s[\"${entityId}\"].attributes.color_temp_kelvin=${attrs.color_temp_kelvin ?? "null"}`,
    `state_after_5s[\"${entityId}\"].attributes.color_mode=${attrs.color_mode ?? "null"}`,
  ];
  if (attrs.hs_color) {
    parts.push(`state_after_5s[\"${entityId}\"].attributes.hs_color=[${attrs.hs_color.join(",")}]`);
  }
  if (attrs.xy_color) {
    parts.push(`state_after_5s[\"${entityId}\"].attributes.xy_color=[${attrs.xy_color.join(",")}]`);
  }
  if (attrs.rgb_color) {
    parts.push(`state_after_5s[\"${entityId}\"].attributes.rgb_color=[${attrs.rgb_color.join(",")}]`);
  }
  return parts.join(", ");
};

const buildLightExpectedLine = (entityId: string, expected: LightExpected) => {
  const parts = [
    `expected.${entityId}.state=${expected.state ?? "null"}`,
    expected.brightness !== undefined
      ? `expected.${entityId}.brightness=${expected.brightness}`
      : null,
    expected.color_temp_kelvin !== undefined
      ? `expected.${entityId}.color_temp_kelvin=${expected.color_temp_kelvin}`
      : null,
  ].filter(Boolean);
  if (expected.color) {
    parts.push(
      `expected.${entityId}.color.${expected.color.mode}=[${expected.color.value.join(",")}]`,
    );
  }
  return parts.join(", ");
};

const getKelvinRange = (state: HaState | null) => {
  const minKelvin = toNumber(state?.attributes?.["min_color_temp_kelvin"]);
  const maxKelvin = toNumber(state?.attributes?.["max_color_temp_kelvin"]);
  const minMireds = toNumber(state?.attributes?.["min_mireds"]);
  const maxMireds = toNumber(state?.attributes?.["max_mireds"]);
  if (minKelvin !== undefined && maxKelvin !== undefined) {
    return { min: minKelvin, max: maxKelvin };
  }
  if (minMireds !== undefined && maxMireds !== undefined && maxMireds > 0 && minMireds > 0) {
    return {
      min: Math.round(1000000 / maxMireds),
      max: Math.round(1000000 / minMireds),
    };
  }
  return null;
};

const DEFAULT_POLICY = {
  allowDomains: new Set([
    "light",
    "scene",
    "script",
    "media_player",
    "climate",
    "cover",
    "fan",
    "switch",
    "input_boolean",
    "input_number",
    "input_text",
    "input_select",
    "input_datetime",
    "input_button",
  ]),
  confirmDomains: new Set(["lock", "alarm_control_panel", "vacuum", "climate"]),
  confirmServices: new Set(["reload", "restart"]),
  denyDomains: new Set([]),
  denyNameTokens: new Set([]),
};

const getPolicyDecision = (input: {
  domain?: string;
  service?: string;
  entityIds?: string[];
  friendlyNames?: string[];
}) => {
  const domain = (input.domain ?? "").toLowerCase();
  const service = (input.service ?? "").toLowerCase();
  if (domain === "persistent_notification" && service === "create") {
    return { action: "allow" as const, reason: "safe:persistent_notification.create" };
  }
  const names = (input.entityIds ?? []).concat(input.friendlyNames ?? []);
  const hasDenyToken = names.some((name) =>
    Array.from(DEFAULT_POLICY.denyNameTokens).some((token) => normalizeName(name).includes(token)),
  );
  if (hasDenyToken) {
    return { action: "confirm_required" as const, reason: "name:risky-token" };
  }
  if (domain && DEFAULT_POLICY.confirmDomains.has(domain)) {
    return { action: "confirm_required" as const, reason: `domain:${domain}` };
  }
  if (service && DEFAULT_POLICY.confirmServices.has(service)) {
    return { action: "confirm_required" as const, reason: `service:${service}` };
  }
  if (domain && DEFAULT_POLICY.allowDomains.has(domain)) {
    return { action: "allow" as const, reason: `domain:${domain}` };
  }
  return { action: "confirm_required" as const, reason: "default" };
};

type PendingAction =
  | {
      kind: "service_call";
      action: {
        domain: string;
        service: string;
        data: Record<string, unknown>;
      };
    }
  | {
      kind: "semantic_override";
      action: {
        scope: "entity" | "device";
        id: string;
        semantic_type?: string;
        control_model?: string;
        smoke_test_safe?: boolean;
        notes?: string;
      };
    }
  | {
      kind: "config_patch";
      action: {
        file: string;
        before: string;
        after: string;
        validate?: boolean;
        reload_domain?: string;
      };
    }
  | {
      kind: "automation_config";
      action: {
        mode: "upsert" | "delete";
        config?: Record<string, unknown>;
        automation_id?: string;
        reload?: boolean;
      };
    };

type PendingActionRecord = {
  token: string;
  createdAt: number;
  expiresAt: number;
  summary: string;
  payload: PendingAction;
};

const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;
const pendingActions = new Map<string, PendingActionRecord>();

const prunePendingActions = () => {
  const now = Date.now();
  for (const [token, record] of pendingActions.entries()) {
    if (record.expiresAt <= now) {
      pendingActions.delete(token);
    }
  }
};

const buildStatesById = (states: HaState[]) => {
  const map = new Map<string, HaState>();
  for (const state of states) {
    map.set(state.entity_id, state);
  }
  return map;
};

const buildAreasById = (areas: RegistryArea[]) => {
  const map = new Map<string, RegistryArea>();
  for (const area of areas) {
    if (area.area_id) {
      map.set(area.area_id, area);
    }
  }
  return map;
};

const buildDevicesById = (devices: RegistryDevice[]) => {
  const map = new Map<string, RegistryDevice>();
  for (const device of devices) {
    if (device.id) {
      map.set(device.id, device);
    }
  }
  return map;
};

const resolveAreaIdForEntity = (entity: RegistryEntity, devicesById: Map<string, RegistryDevice>) => {
  if (entity.area_id) return entity.area_id;
  const device = entity.device_id ? devicesById.get(entity.device_id) : undefined;
  return device?.area_id ?? "";
};

const resolveAreaNameForEntity = (
  entity: RegistryEntity,
  devicesById: Map<string, RegistryDevice>,
  areasById: Map<string, RegistryArea>,
) => {
  const areaId = resolveAreaIdForEntity(entity, devicesById);
  return areasById.get(areaId)?.name ?? "";
};

const resolveDeviceNameForEntity = (
  entity: RegistryEntity,
  devicesById: Map<string, RegistryDevice>,
) => {
  const device = entity.device_id ? devicesById.get(entity.device_id) : undefined;
  return device?.name ?? "";
};

const resolveFriendlyName = (entity: RegistryEntity, statesById: Map<string, HaState>) => {
  const state = statesById.get(entity.entity_id);
  const friendly = safeString(state?.attributes?.["friendly_name"]);
  if (friendly) return friendly;
  return safeString(entity.name || entity.original_name || entity.entity_id);
};

const parseNumericState = (value: unknown) => {
  const num = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(num) ? num : null;
};

const inferSensorType = (state?: HaState) => {
  const deviceClass = safeString(state?.attributes?.["device_class"]).toLowerCase();
  const unit = safeString(state?.attributes?.["unit_of_measurement"]).toLowerCase();
  const entityId = safeString(state?.entity_id).toLowerCase();
  if (deviceClass === "illuminance" || unit === "lx" || entityId.includes("lux")) {
    return { type: "illuminance", unit };
  }
  if (deviceClass === "power" || unit === "w" || entityId.includes("power") || entityId.includes("watt")) {
    return { type: "power", unit };
  }
  if (deviceClass === "energy" || unit.includes("kwh") || entityId.includes("energy")) {
    return { type: "energy", unit };
  }
  return { type: "unknown", unit };
};

const findAreaForEntity = (
  entityId: string,
  snapshot: { entities: RegistryEntity[]; devices: RegistryDevice[]; areas: RegistryArea[] },
) => {
  const devicesById = buildDevicesById(snapshot.devices);
  const areasById = buildAreasById(snapshot.areas);
  const entity = snapshot.entities.find((entry) => entry.entity_id === entityId);
  if (!entity) return { area_id: "", area_name: "" };
  const areaId = resolveAreaIdForEntity(entity, devicesById);
  return { area_id: areaId, area_name: areasById.get(areaId)?.name ?? "" };
};

const collectGroundTruthSensors = (
  areaName: string,
  snapshot: { indexes: { by_area_name: Record<string, { entity_ids: string[] }> }; states: HaState[] },
) => {
  const areaEntry = snapshot.indexes.by_area_name[areaName];
  if (!areaEntry) return [];
  const statesById = buildStatesById(snapshot.states);
  return areaEntry.entity_ids
    .filter((entityId) => entityId.startsWith("sensor."))
    .map((entityId) => statesById.get(entityId))
    .filter((state): state is HaState => Boolean(state))
    .map((state) => {
      const meta = inferSensorType(state);
      return {
        entity_id: state.entity_id,
        type: meta.type,
        unit: meta.unit,
      };
    })
    .filter((entry) => entry.type !== "unknown");
};

const findAreaMatch = (areas: RegistryArea[], areaName: string) => {
  const normalized = normalizeName(areaName);
  const exact = areas.find((area) => normalizeName(area.name) === normalized);
  if (exact) {
    return { area: exact, suggestions: [] as string[] };
  }
  const suggestions = areas
    .map((area) => ({ name: area.name, norm: normalizeName(area.name) }))
    .filter((area) => area.norm && (area.norm.includes(normalized) || normalized.includes(area.norm)))
    .map((area) => area.name)
    .slice(0, 5);
  return { area: null, suggestions };
};

const pickAreaNameFromQuery = (areas: RegistryArea[], query: string) => {
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery) return "";
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  let best: { name: string; score: number; norm: string } | null = null;
  for (const area of areas) {
    const normalizedArea = normalizeName(area.name);
    if (!normalizedArea) continue;
    let score = 0;
    if (normalizedQuery.includes(normalizedArea)) score += 50;
    if (normalizedArea.includes(normalizedQuery)) score += 40;
    const areaTokens = normalizedArea.split(" ").filter(Boolean);
    let tokenMatches = 0;
    for (const token of areaTokens) {
      if (token.length < 3) continue;
      if (queryTokens.includes(token)) {
        tokenMatches += 1;
        score += 6;
      }
    }
    if (tokenMatches > 0) score += Math.min(12, tokenMatches * 2);
    score += Math.min(8, Math.floor(normalizedArea.length / 4));
    if (!best || score > best.score || (score === best.score && normalizedArea.length > best.norm.length)) {
      best = { name: area.name, score, norm: normalizedArea };
    }
  }
  if (!best || best.score < 20) return "";
  return best.name;
};

const SEMANTIC_OVERRIDE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    entity_overrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          semantic_type: { type: "string" },
          control_model: { type: "string" },
          smoke_test_safe: { type: "boolean" },
          notes: { type: "string" },
          ts: { type: "string" },
        },
      },
    },
    device_overrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          semantic_type: { type: "string" },
          control_model: { type: "string" },
          smoke_test_safe: { type: "boolean" },
          notes: { type: "string" },
          ts: { type: "string" },
        },
      },
    },
  },
};

const ensureSemanticDataDir = async () => {
  await mkdir(SEMANTIC_DATA_DIR, { recursive: true });
};

const normalizeOverrideStore = (parsed: unknown): SemanticOverrideStore => {
  const empty: SemanticOverrideStore = { entity_overrides: {}, device_overrides: {} };
  if (!parsed || typeof parsed !== "object") return empty;
  const record = parsed as Record<string, unknown>;
  const entityOverrides =
    record.entity_overrides && typeof record.entity_overrides === "object"
      ? (record.entity_overrides as Record<string, SemanticOverrideEntry>)
      : {};
  const deviceOverrides =
    record.device_overrides && typeof record.device_overrides === "object"
      ? (record.device_overrides as Record<string, SemanticOverrideEntry>)
      : {};
  return {
    entity_overrides: entityOverrides,
    device_overrides: deviceOverrides,
  };
};

const loadSemanticOverrides = async (): Promise<SemanticOverrideStore> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(SEMANTIC_OVERRIDES_PATH, "utf8");
    return normalizeOverrideStore(JSON.parse(raw));
  } catch {
    await ensureSemanticDataDir();
    const empty: SemanticOverrideStore = { entity_overrides: {}, device_overrides: {} };
    await writeFile(SEMANTIC_OVERRIDES_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
};

const saveSemanticOverrides = async (store: SemanticOverrideStore) => {
  await ensureSemanticDataDir();
  await writeFile(SEMANTIC_OVERRIDES_PATH, JSON.stringify(store, null, 2));
};

const SEMANTIC_RISKY_TYPES = new Set([
  "lock",
  "garage_door",
  "door",
  "security",
  "alarm",
  "alarm_control_panel",
  "vacuum",
  "access_control",
  "climate",
]);

const buildSemanticScores = (input: {
  entity: InventoryEntity;
  areaName: string;
  deviceName: string;
}) => {
  const scores: Record<string, { score: number; reasons: string[] }> = {};
  const add = (type: string, amount: number, reason: string) => {
    if (!scores[type]) scores[type] = { score: 0, reasons: [] };
    scores[type].score += amount;
    scores[type].reasons.push(reason);
  };
  const entityName = normalizeName(`${input.entity.friendly_name} ${input.entity.original_name}`);
  const area = normalizeName(input.areaName);
  const device = normalizeName(input.deviceName);
  const icon = normalizeName(safeString(input.entity.attributes?.["icon"]));
  const deviceClass = normalizeName(safeString(input.entity.attributes?.["device_class"]));
  const domain = input.entity.domain;

  const keywords: Record<string, string[]> = {
    light: ["light", "lamp", "led", "bulb", "svjetlo", "svjetla", "lampa"],
    switch: ["switch", "relay"],
    fan: ["fan", "vent", "blower", "ventilator", "prana"],
    fan_switch: ["fan", "vent", "blower", "ventilator", "prana"],
    cover: ["cover", "blind", "shade", "curtain", "shutter", "roleta", "rolete"],
    climate: ["climate", "thermostat", "heater", "radiator", "klima", "ac", "air", "grijanje"],
    media_player: ["tv", "media", "speaker", "audio", "sound", "music", "sonos", "zvucnik", "zvučnik"],
    lock: ["lock", "brava"],
    garage_door: ["garage"],
    door: ["door", "gate", "vrata"],
    security: ["camera", "security", "alarm", "sirena"],
    outlet: ["outlet", "plug", "socket", "uticnica", "utičnica"],
    pump: ["pump", "pumpe", "pumpa"],
    heater: ["heater", "grijac", "grijač", "radijator"],
    boiler: ["boiler", "bojler"],
    vacuum: ["vacuum", "usis", "robot"],
  };

  for (const [type, tokens] of Object.entries(keywords)) {
    if (type === "fan_switch" && domain !== "switch") continue;
    for (const token of tokens) {
      if (entityName.includes(token)) add(type, 8, `name:${token}`);
      if (device.includes(token)) add(type, 4, `device:${token}`);
      if (area.includes(token)) add(type, 2, `area:${token}`);
      if (icon.includes(token)) add(type, 2, `icon:${token}`);
      if (deviceClass.includes(token)) add(type, 6, `device_class:${token}`);
    }
  }

  if (domain) add(domain, 10, `domain:${domain}`);
  return scores;
};

const resolveSemanticType = (
  entity: InventoryEntity,
  overrides: SemanticOverrideStore,
): SemanticResult => {
  const entityOverride = overrides.entity_overrides[entity.entity_id];
  const deviceOverride = entity.device_id ? overrides.device_overrides[entity.device_id] : undefined;
  const override = entityOverride ?? deviceOverride;
  if (override?.semantic_type) {
    return {
      semantic_type: override.semantic_type,
      confidence: 1,
      reasons: [
        `override:${override.semantic_type}`,
        override.notes ?? "",
        override === deviceOverride ? "scope:device" : "scope:entity",
      ].filter(Boolean),
      source: "override",
    };
  }

  const scores = buildSemanticScores({
    entity,
    areaName: entity.area_name,
    deviceName: entity.device_name,
  });
  const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  const top = sorted[0];
  const second = sorted[1];
  const topScore = top?.[1].score ?? 0;
  const secondScore = second?.[1].score ?? 0;
  const confidence = topScore === 0 ? 0 : topScore / Math.max(topScore + secondScore, topScore);
  const semantic_type = top?.[0] ?? entity.domain;
  const reasons = top?.[1].reasons ?? [`domain:${entity.domain}`];
  return { semantic_type, confidence, reasons, source: "inferred" };
};

const isRiskySemantic = (semantic: SemanticResult) => {
  if (SEMANTIC_RISKY_TYPES.has(semantic.semantic_type)) return true;
  return false;
};

const buildFallbackInventoryEntity = (entityId: string, state?: HaState): InventoryEntity => {
  const domain = entityId.split(".")[0] ?? "";
  const friendly = safeString(state?.attributes?.["friendly_name"]) || entityId;
  return {
    domain,
    entity_id: entityId,
    friendly_name: friendly,
    original_name: "",
    aliases: [],
    device_id: "",
    area_id: "",
    area_name: "",
    device_name: "",
    manufacturer: "",
    model: "",
    integration: "",
    platform: "",
    attributes: (state?.attributes ?? {}) as Record<string, unknown>,
    services: [],
  };
};

const buildSemanticAssessment = async (entityIds: string[]) => {
  const overrides = await loadSemanticOverrides();
  const learnedStore = await loadLearnedSemanticMap();
  const snapshot = await fetchInventorySnapshot().catch(() => null);
  const byId: Record<string, SemanticResult> = {};
  const hints: string[] = [];
  for (const entityId of entityIds) {
    const fallbackState = await fetchEntityState(entityId);
    const entity =
      snapshot?.entities?.[entityId] ?? buildFallbackInventoryEntity(entityId, fallbackState ?? null);
    const deviceEntities = snapshot
      ? Object.values(snapshot.entities).filter((entry) => entry.device_id && entry.device_id === entity.device_id)
      : [];
    const resolution = buildSemanticResolution({
      entity,
      deviceEntities,
      overrides,
      learnedStore,
      servicesByDomain: snapshot?.services_by_domain ?? {},
      deviceGraph: snapshot?.device_graph ?? {},
    });
    const semantic: SemanticResult = {
      semantic_type: resolution.semantic_type,
      confidence: resolution.confidence,
      reasons: resolution.reasons,
      source: resolution.source,
    };
    byId[entityId] = semantic;
    if (semantic.confidence < 0.55 && isRiskySemantic(semantic)) {
      hints.push(`Confirm semantic type for ${entityId} (override in semantic_overrides.json).`);
    }
  }
  const requiresConfirm = Object.entries(byId).some(
    ([, semantic]) => semantic.confidence < 0.55 && isRiskySemantic(semantic),
  );
  return {
    by_entity: byId,
    requires_confirm: requiresConfirm,
    hints,
  };
};

const SEMANTIC_TYPE_KEYWORDS: Record<string, string[]> = {
  light: ["light", "lamp", "led", "bulb", "svjetlo", "svjetla", "lampa"],
  fan: ["fan", "vent", "blower", "ventilator", "prana", "ventilacija"],
  ventilation: ["ventilacija", "ispuh", "odsis", "napa", "hood", "exhaust", "extractor", "lufter", "abzug"],
  outlet: ["outlet", "plug", "socket", "uticnica", "utičnica", "steckdose"],
  pump: ["pump", "pumpe", "pumpa", "circulation", "cirkulacija"],
  heater: ["heater", "radijator", "grijanje", "grijac", "grijač", "radiator"],
  boiler: ["boiler", "bojler", "water heater"],
  tv: ["tv", "television", "televizor"],
  speaker: ["speaker", "sonos", "audio", "sound", "music", "zvucnik", "zvučnik"],
  media_player: ["media", "player", "mediaplayer"],
  climate: ["climate", "thermostat", "klima", "ac", "air", "heat", "cool", "heizung"],
  cover: ["cover", "blind", "shade", "curtain", "shutter", "roleta", "rolete", "zavjesa"],
  lock: ["lock", "brava", "zakljucaj", "zaključaj"],
  vacuum: ["vacuum", "usis", "usisavač", "robot"],
  alarm: ["alarm", "sirena", "siren", "security"],
};

const SEMANTIC_RISK_LEVELS = {
  low: new Set(["light", "fan", "switch", "generic_switch", "outlet", "input_boolean", "button"]),
  medium: new Set(["media_player", "cover", "number", "select"]),
  high: new Set(["lock", "alarm", "alarm_control_panel", "climate", "vacuum", "security", "door", "garage_door"]),
};

const inferSemanticFromText = (text: string) => {
  const normalized = normalizeName(text);
  if (!normalized) return "";
  const scores: Record<string, number> = {};
  for (const [semantic, tokens] of Object.entries(SEMANTIC_TYPE_KEYWORDS)) {
    for (const token of tokens) {
      if (normalized.includes(normalizeName(token))) {
        scores[semantic] = (scores[semantic] ?? 0) + 1;
      }
    }
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? "";
};

const getRiskLevel = (semanticType: string, domain: string) => {
  const normalizedSemantic = normalizeName(semanticType);
  if (SEMANTIC_RISK_LEVELS.high.has(normalizedSemantic) || SEMANTIC_RISK_LEVELS.high.has(domain)) return "high";
  if (SEMANTIC_RISK_LEVELS.medium.has(normalizedSemantic) || SEMANTIC_RISK_LEVELS.medium.has(domain)) return "medium";
  return "low";
};

const deriveControlModel = (entity: InventoryEntity) => {
  const attrs = entity.attributes ?? {};
  if (entity.domain === "light") {
    const modes = Array.isArray(attrs["supported_color_modes"]) ? attrs["supported_color_modes"] : [];
    if (modes.length > 0) return "color";
    if (attrs["brightness"] !== undefined) return "dimmer_pct";
    return "onoff";
  }
  if (entity.domain === "fan") {
    if (attrs["percentage"] !== undefined) return "percentage";
    if (Array.isArray(attrs["preset_modes"]) && attrs["preset_modes"].length > 0) return "preset";
    return "onoff";
  }
  if (entity.domain === "climate") return "setpoint";
  if (entity.domain === "media_player") return "volume_playback";
  if (entity.domain === "cover") {
    if (attrs["current_position"] !== undefined) return "position";
    return "open_close";
  }
  if (entity.domain === "lock") return "lock";
  if (entity.domain === "alarm_control_panel") return "arm_disarm";
  if (entity.domain === "vacuum") return "vacuum";
  if (entity.domain === "number") return "setpoint";
  if (entity.domain === "select") return "mode_select";
  if (entity.domain === "input_boolean") return "onoff";
  if (entity.domain === "scene" || entity.domain === "script") return "trigger";
  if (entity.domain === "switch") return "onoff";
  return "onoff";
};

const recommendActions = (input: {
  semanticType: string;
  controlModel: string;
  domain: string;
  servicesByDomain: Record<string, string[]> | undefined;
}) => {
  const services = input.servicesByDomain?.[input.domain] ?? [];
  const has = (service: string) => services.includes(service);
  const primaryCandidates: Record<string, string[]> = {
    light: ["light.turn_on"],
    fan: ["fan.set_percentage", "fan.set_preset_mode", "fan.turn_on"],
    ventilation: ["fan.set_percentage", "fan.turn_on"],
    outlet: ["switch.turn_on"],
    pump: ["switch.turn_on"],
    heater: ["climate.set_temperature", "switch.turn_on"],
    boiler: ["climate.set_temperature", "switch.turn_on"],
    tv: ["media_player.turn_on", "media_player.volume_set"],
    speaker: ["media_player.volume_set", "media_player.media_play"],
    climate: ["climate.set_temperature"],
    cover: ["cover.set_cover_position", "cover.open_cover", "cover.close_cover"],
    lock: ["lock.lock", "lock.unlock"],
    vacuum: ["vacuum.start", "vacuum.return_to_base"],
    alarm: ["alarm_control_panel.alarm_arm_home", "alarm_control_panel.alarm_disarm"],
    generic_switch: ["switch.turn_on"],
    generic_actuator: ["switch.turn_on"],
  };
  const fallbacks: string[] = [];
  const primaryList = primaryCandidates[input.semanticType] ?? [`${input.domain}.turn_on`];
  let primary = primaryList[0];
  for (const candidate of primaryList) {
    const [domain, service] = candidate.split(".");
    if (domain === input.domain && has(service)) {
      primary = candidate;
      break;
    }
  }
  for (const candidate of primaryList.slice(1)) {
    fallbacks.push(candidate);
  }
  if (!fallbacks.includes(`${input.domain}.turn_on`)) {
    fallbacks.push(`${input.domain}.turn_on`);
  }
  return { primary, fallbacks };
};

const addSemanticScore = (
  scores: Record<string, { score: number; reasons: string[]; strong: number; weak: number }>,
  semanticType: string,
  amount: number,
  reason: string,
  strength: "strong" | "weak",
) => {
  if (!scores[semanticType]) {
    scores[semanticType] = { score: 0, reasons: [], strong: 0, weak: 0 };
  }
  scores[semanticType].score += amount;
  scores[semanticType].reasons.push(reason);
  if (strength === "strong") {
    scores[semanticType].strong += 1;
  } else {
    scores[semanticType].weak += 1;
  }
};

const applyKeywordScores = (
  scores: Record<string, { score: number; reasons: string[]; strong: number; weak: number }>,
  text: string,
  weight: number,
  reasonPrefix: string,
  strength: "strong" | "weak",
) => {
  const normalized = normalizeName(text);
  if (!normalized) return;
  for (const [type, tokens] of Object.entries(SEMANTIC_TYPE_KEYWORDS)) {
    for (const token of tokens) {
      if (normalized.includes(normalizeName(token))) {
        addSemanticScore(scores, type, weight, `${reasonPrefix}:${token}`, strength);
      }
    }
  }
};

const mapDomainSemantic = (domain: string) => {
  if (domain === "alarm_control_panel") return "alarm";
  if (domain === "water_heater") return "boiler";
  if (domain === "switch") return "generic_switch";
  return domain;
};

const pickSafeSemanticFallback = (entity: InventoryEntity, scores: Record<string, { score: number }>) => {
  if (entity.domain === "switch") {
    const outletScore = scores["outlet"]?.score ?? 0;
    const switchScore = scores["generic_switch"]?.score ?? 0;
    if (outletScore >= switchScore + 6) return "outlet";
    return "generic_switch";
  }
  const mapped = mapDomainSemantic(entity.domain);
  return mapped || "generic_switch";
};

const isTelemetryDomain = (domain: string) => domain === "sensor" || domain === "binary_sensor";

const buildTelemetrySemanticType = (entity: InventoryEntity, deviceDomains: Set<string>) => {
  if (deviceDomains.has("vacuum")) return "telemetry.vacuum";
  const deviceClass = safeString(entity.device_class ?? "") || safeString(entity.original_device_class ?? "");
  const normalized = normalizeName(deviceClass);
  if (normalized) return `telemetry.${normalized}`;
  const stateClass = normalizeName(safeString(entity.attributes?.["state_class"]));
  if (stateClass) return `telemetry.${stateClass}`;
  const unit = normalizeName(safeString(entity.attributes?.["unit_of_measurement"]));
  if (unit) return `telemetry.${unit}`;
  return "telemetry.generic";
};

const buildSemanticResolution = (input: {
  entity: InventoryEntity;
  deviceEntities: InventoryEntity[];
  overrides: SemanticOverrideStore;
  learnedStore: LearnedSemanticStore;
  servicesByDomain: Record<string, string[]>;
  deviceGraph: Record<string, DeviceGraphEntry>;
}): SemanticResolution => {
  const deviceDomains = new Set(input.deviceEntities.map((entry) => entry.domain));
  if (isTelemetryDomain(input.entity.domain)) {
    const telemetryType = buildTelemetrySemanticType(input.entity, deviceDomains);
    const telemetryReasons = [`telemetry_domain:${input.entity.domain}`];
    if (telemetryType !== "telemetry.generic") telemetryReasons.push(`telemetry_type:${telemetryType}`);
    const missingSignals: string[] = [];
    if (!input.entity.device_id) missingSignals.push("missing:device_id");
    if (!input.entity.device_fingerprint) missingSignals.push("missing:device_fingerprint");
    if (!input.entity.device_class && !input.entity.original_device_class) {
      missingSignals.push("missing:device_class");
    }
    return {
      semantic_type: telemetryType,
      control_model: "telemetry",
      confidence: 0.9,
      reasons: telemetryReasons,
      missing_signals: missingSignals,
      non_actionable: true,
      recommended_primary: "",
      recommended_fallbacks: [],
      smoke_test_safe: true,
      preferred_control_entity: input.entity.entity_id,
      entity_fingerprint: buildEntityFingerprint(input.entity),
      source: "inferred",
      ambiguity: { ok: true, reason: "telemetry" },
    };
  }

  const deviceOverride = input.entity.device_id
    ? input.overrides.device_overrides[input.entity.device_id]
    : undefined;
  const entityOverride = input.overrides.entity_overrides[input.entity.entity_id];
  const override = entityOverride ?? deviceOverride;
  const learned = input.learnedStore.entities[input.entity.entity_id];
  const fingerprintKey = input.entity.device_fingerprint ?? "";
  const learnedFingerprint = fingerprintKey ? input.learnedStore.fingerprints[fingerprintKey] : undefined;
  if (!override?.semantic_type && learned && learned.success_count >= LEARNED_SUCCESS_THRESHOLD) {
    const semanticType = learned.semantic_type || input.entity.domain;
    const controlModel = learned.control_model || deriveControlModel(input.entity);
    const { primary, fallbacks } = recommendActions({
      semanticType,
      controlModel,
      domain: input.entity.domain,
      servicesByDomain: input.servicesByDomain,
    });
    const confidence = Math.min(0.98, 0.8 + learned.success_count * 0.05);
    return {
      semantic_type: semanticType,
      control_model: controlModel,
      confidence,
      reasons: [
        `learned:${learned.success_count}/${LEARNED_SUCCESS_THRESHOLD}`,
        learned.last_intent ?? "",
      ].filter(Boolean),
      missing_signals: [],
      non_actionable: false,
      recommended_primary: primary,
      recommended_fallbacks: fallbacks,
      smoke_test_safe: false,
      preferred_control_entity: input.entity.entity_id,
      entity_fingerprint: buildEntityFingerprint(input.entity),
      source: "inferred",
      ambiguity: { ok: true },
    };
  }
  if (!override?.semantic_type && learnedFingerprint && learnedFingerprint.success_count >= LEARNED_SUCCESS_THRESHOLD) {
    const semanticType = learnedFingerprint.semantic_type || input.entity.domain;
    const controlModel = learnedFingerprint.control_model || deriveControlModel(input.entity);
    const { primary, fallbacks } = recommendActions({
      semanticType,
      controlModel,
      domain: input.entity.domain,
      servicesByDomain: input.servicesByDomain,
    });
    const confidence = Math.min(0.95, 0.75 + learnedFingerprint.success_count * 0.04);
    return {
      semantic_type: semanticType,
      control_model: controlModel,
      confidence,
      reasons: [
        `learned_fingerprint:${learnedFingerprint.success_count}/${LEARNED_SUCCESS_THRESHOLD}`,
        learnedFingerprint.last_intent ?? "",
      ].filter(Boolean),
      missing_signals: [],
      non_actionable: false,
      recommended_primary: primary,
      recommended_fallbacks: fallbacks,
      smoke_test_safe: false,
      preferred_control_entity: input.entity.entity_id,
      entity_fingerprint: buildEntityFingerprint(input.entity),
      source: "inferred",
      ambiguity: { ok: true },
    };
  }
  if (override?.semantic_type || override?.control_model) {
    const semanticType = override.semantic_type ?? input.entity.domain;
    const controlModel = override.control_model ?? deriveControlModel(input.entity);
    const { primary, fallbacks } = recommendActions({
      semanticType,
      controlModel,
      domain: input.entity.domain,
      servicesByDomain: input.servicesByDomain,
    });
    return {
      semantic_type: semanticType,
      control_model: controlModel,
      confidence: 1,
      reasons: [
        `override:${semanticType}`,
        override.notes ?? "",
        override === deviceOverride ? "scope:device" : "scope:entity",
      ].filter(Boolean),
      missing_signals: [],
      non_actionable: false,
      recommended_primary: primary,
      recommended_fallbacks: fallbacks,
      smoke_test_safe: Boolean(override.smoke_test_safe ?? false),
      preferred_control_entity: input.entity.entity_id,
      entity_fingerprint: buildEntityFingerprint(input.entity),
      source: "override",
      ambiguity: { ok: true },
    };
  }

  const scores: Record<string, { score: number; reasons: string[]; strong: number; weak: number }> = {};
  const missingSignals = new Set<string>();
  if (!input.entity.device_id) missingSignals.add("missing:device_id");
  if (!input.entity.unique_id) missingSignals.add("missing:entity_unique_id");
  if (!input.entity.area_name) missingSignals.add("missing:area_name");
  if (!input.entity.device_name && !input.entity.manufacturer && !input.entity.model) {
    missingSignals.add("missing:device_identity");
  }
  if (!input.entity.device_class && !input.entity.original_device_class) {
    missingSignals.add("missing:device_class");
  }
  if (!input.entity.capabilities_hints || Object.keys(input.entity.capabilities_hints).length === 0) {
    missingSignals.add("missing:capabilities");
  }
  if (!input.entity.friendly_name && !input.entity.original_name && input.entity.aliases.length === 0) {
    missingSignals.add("missing:names");
  }

  const domainSemantic = mapDomainSemantic(input.entity.domain);
  if (domainSemantic) {
    addSemanticScore(scores, domainSemantic, 16, `domain:${input.entity.domain}`, "strong");
  }

  const deviceClass = normalizeName(
    safeString(input.entity.device_class ?? "") || safeString(input.entity.original_device_class ?? ""),
  );
  if (deviceClass) {
    if (deviceClass.includes("outlet") || deviceClass.includes("plug")) {
      addSemanticScore(scores, "outlet", 12, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("fan")) {
      addSemanticScore(scores, "fan", 12, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("pump")) {
      addSemanticScore(scores, "pump", 10, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("heater") || deviceClass.includes("heat")) {
      addSemanticScore(scores, "heater", 10, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("garage")) {
      addSemanticScore(scores, "garage_door", 10, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("door")) {
      addSemanticScore(scores, "door", 10, `device_class:${deviceClass}`, "strong");
    } else if (deviceClass.includes("lock")) {
      addSemanticScore(scores, "lock", 12, `device_class:${deviceClass}`, "strong");
    }
  }

  const hints = input.entity.capabilities_hints ?? {};
  if (input.entity.domain === "light") {
    if (Array.isArray(hints.supported_color_modes) && hints.supported_color_modes.length > 0) {
      addSemanticScore(scores, "light", 12, "capability:color_modes", "strong");
    }
    if (hints.brightness !== null && hints.brightness !== undefined) {
      addSemanticScore(scores, "light", 10, "capability:brightness", "strong");
    }
  }
  if (input.entity.domain === "fan") {
    if (hints.percentage !== null && hints.percentage !== undefined) {
      addSemanticScore(scores, "fan", 10, "capability:percentage", "strong");
    }
    if (Array.isArray(hints.preset_modes) && hints.preset_modes.length > 0) {
      addSemanticScore(scores, "fan", 8, "capability:preset_modes", "strong");
    }
  }
  if (input.entity.domain === "climate") {
    if (Array.isArray(hints.hvac_modes) && hints.hvac_modes.length > 0) {
      addSemanticScore(scores, "climate", 12, "capability:hvac_modes", "strong");
    }
    if (hints.min_temp !== null && hints.min_temp !== undefined) {
      addSemanticScore(scores, "climate", 8, "capability:temperature", "strong");
    }
  }
  if (input.entity.domain === "cover") {
    if (hints.current_position !== null && hints.current_position !== undefined) {
      addSemanticScore(scores, "cover", 10, "capability:position", "strong");
    }
  }
  if (input.entity.domain === "media_player") {
    if (hints.volume_level !== null && hints.volume_level !== undefined) {
      addSemanticScore(scores, "media_player", 10, "capability:volume", "strong");
    }
    if (Array.isArray(hints.source_list) && hints.source_list.length > 0) {
      addSemanticScore(scores, "media_player", 8, "capability:sources", "strong");
    }
  }

  const entityText = `${input.entity.entity_id} ${input.entity.friendly_name} ${input.entity.original_name} ${input.entity.state ?? ""}`;
  const deviceText = `${input.entity.device_name} ${input.entity.manufacturer} ${input.entity.model}`;
  const integrationText = `${input.entity.integration} ${input.entity.platform}`;
  const areaText = input.entity.area_name ?? "";

  applyKeywordScores(scores, entityText, 4, "name", "weak");
  applyKeywordScores(scores, deviceText, 3, "device", "weak");
  applyKeywordScores(scores, integrationText, 2, "integration", "weak");
  applyKeywordScores(scores, areaText, 1, "area", "weak");

  for (const [type, tokens] of Object.entries(NEGATIVE_SEMANTIC_TOKENS)) {
    for (const token of tokens) {
      if (normalizeName(entityText).includes(normalizeName(token)) || normalizeName(deviceText).includes(normalizeName(token))) {
        addSemanticScore(scores, type, -4, `negative:${token}`, "weak");
      }
    }
  }

  const deviceGraphKey = deviceGraphKeyForEntity(input.entity);
  const graphEntry = input.deviceGraph[deviceGraphKey];
  const graphDomains = new Set(
    graphEntry?.entity_domains?.length ? graphEntry.entity_domains : input.deviceEntities.map((entry) => entry.domain),
  );
  if (!graphEntry) {
    missingSignals.add("missing:device_graph");
  }
  if (input.entity.domain === "switch") {
    if (graphDomains.has("climate") || graphDomains.has("water_heater")) {
      addSemanticScore(scores, "outlet", -8, "cluster:climate_or_water_heater", "strong");
      addSemanticScore(scores, "heater", 6, "cluster:climate_or_water_heater", "strong");
      addSemanticScore(scores, "boiler", 6, "cluster:climate_or_water_heater", "strong");
    }
    if (graphDomains.has("fan")) {
      addSemanticScore(scores, "fan", 5, "cluster:fan", "strong");
    }
    if (graphDomains.has("light")) {
      addSemanticScore(scores, "light", 3, "cluster:light", "weak");
    }
  }
  if (graphEntry?.via_device_id && input.deviceGraph[graphEntry.via_device_id]) {
    const via = input.deviceGraph[graphEntry.via_device_id];
    const viaText = `${via.device_name} ${via.manufacturer} ${via.model}`;
    applyKeywordScores(scores, viaText, 2, "via_device", "weak");
  }

  if (input.entity.unique_id && domainSemantic) {
    addSemanticScore(scores, domainSemantic, 2, "unique_id", "weak");
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  const top = sorted[0];
  const second = sorted[1];
  const topScore = top?.[1].score ?? 0;
  const secondScore = second?.[1].score ?? 0;
  let confidence = topScore === 0 ? 0 : topScore / Math.max(topScore + secondScore, topScore);
  let semanticType = top?.[0] ?? domainSemantic ?? input.entity.domain;
  if (input.entity.domain === "switch" && semanticType === "switch") {
    semanticType = "generic_switch";
  }
  if (semanticType === "ventilation") {
    semanticType = "fan";
  }
  const hasStrongSignals = (top?.[1].strong ?? 0) > 0;
  const ambiguous = confidence < 0.55 || !hasStrongSignals;
  const riskLevel = getRiskLevel(semanticType, input.entity.domain);
  const reasons = top?.[1].reasons?.length ? [...top[1].reasons] : [`domain:${input.entity.domain}`];
  if (ambiguous && riskLevel !== "high") {
    const safeType = pickSafeSemanticFallback(input.entity, scores);
    if (safeType !== semanticType) {
      semanticType = safeType;
      reasons.push(`safe_default:${safeType}`);
    } else {
      reasons.push("safe_default");
    }
    confidence = Math.max(confidence, 0.4);
  }
  const controlModel = deriveControlModel(input.entity);
  const { primary, fallbacks } = recommendActions({
    semanticType,
    controlModel,
    domain: input.entity.domain,
    servicesByDomain: input.servicesByDomain,
  });
  const ambiguity =
    ambiguous && riskLevel === "high"
      ? { ok: false, reason: "low_confidence", needs_override: true }
      : { ok: true, reason: ambiguous ? "safe_default" : undefined };
  return {
    semantic_type: semanticType,
    control_model: controlModel,
    confidence,
    reasons,
    missing_signals: [...missingSignals],
    non_actionable: false,
    recommended_primary: primary,
    recommended_fallbacks: fallbacks,
    smoke_test_safe: false,
    preferred_control_entity: input.entity.entity_id,
    entity_fingerprint: buildEntityFingerprint(input.entity),
    source: "inferred",
    ambiguity,
  };
};

const buildEntityFingerprint = (entity: InventoryEntity) => ({
  entity_id: entity.entity_id,
  domain: entity.domain,
  state: entity.state ?? null,
  friendly_name: entity.friendly_name,
  original_name: entity.original_name,
  device_class: entity.device_class ?? null,
  original_device_class: entity.original_device_class ?? null,
  platform: entity.platform ?? null,
  integration: entity.integration ?? null,
  config_entry_id: entity.config_entry_id ?? null,
  entity_category: entity.entity_category ?? null,
  unique_id: entity.unique_id ?? null,
  disabled_by: entity.disabled_by ?? null,
  device_id: entity.device_id ?? null,
  device_fingerprint: entity.device_fingerprint ?? null,
  device_name: entity.device_name ?? null,
  manufacturer: entity.manufacturer ?? null,
  model: entity.model ?? null,
  identifiers: entity.device_identifiers ?? [],
  via_device_id: entity.via_device_id ?? null,
  area_id: entity.area_id ?? null,
  area_name: entity.area_name ?? null,
  capabilities_hints: entity.capabilities_hints ?? {},
});

const NEGATIVE_SEMANTIC_TOKENS: Record<string, string[]> = {
  fan: ["tv", "speaker", "audio", "media", "music"],
  ventilation: ["tv", "speaker", "audio", "media", "music"],
  outlet: ["tv", "speaker"],
  pump: ["tv", "speaker"],
  light: ["sensor", "battery", "rssi"],
};

const tokenizeText = (value: string) =>
  normalizeName(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

const buildSemanticMapFromSnapshot = async (snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>) => {
  const overrides = await loadSemanticOverrides();
  const learnedStore = await loadLearnedSemanticMap();
  const devices: Record<string, InventoryEntity[]> = {};
  for (const entity of Object.values(snapshot.entities)) {
    const deviceId = entity.device_id || "unknown";
    devices[deviceId] = devices[deviceId] ?? [];
    devices[deviceId].push(entity);
  }
  const byEntity: Record<string, SemanticResolution> = {};
  const needsOverride: Array<{ entity_id: string; reason: string; suggestion: string }> = [];
  for (const entity of Object.values(snapshot.entities)) {
    const deviceEntities = devices[entity.device_id || "unknown"] ?? [];
    const resolution = buildSemanticResolution({
      entity,
      deviceEntities,
      overrides,
      learnedStore,
      servicesByDomain: snapshot.services_by_domain ?? {},
      deviceGraph: snapshot.device_graph ?? {},
    });
    byEntity[entity.entity_id] = resolution;
    if (
      !resolution.non_actionable &&
      !resolution.ambiguity.ok &&
      resolution.ambiguity.needs_override &&
      SEMANTIC_RISKY_TYPES.has(resolution.semantic_type)
    ) {
      needsOverride.push({
        entity_id: entity.entity_id,
        reason: resolution.ambiguity.reason ?? "low_confidence",
        suggestion: JSON.stringify({
          entity_overrides: {
            [entity.entity_id]: {
              semantic_type: resolution.semantic_type,
              control_model: resolution.control_model,
              smoke_test_safe: false,
            },
          },
        }),
      });
    }
  }
  const byDevice: Record<string, SemanticResolution> = {};
  for (const [deviceId, entityList] of Object.entries(devices)) {
    const primary = entityList[0];
    if (!primary) continue;
    byDevice[deviceId] = byEntity[primary.entity_id];
  }
  const priorityDomains = ["fan", "climate", "light", "vacuum", "media_player", "cover", "switch"];
  for (const [deviceId, entityList] of Object.entries(devices)) {
    const candidates = entityList
      .map((entry) => byEntity[entry.entity_id])
      .filter(Boolean);
    if (candidates.length === 0) continue;
    const sorted = candidates.sort((a, b) => {
      const aIndex = priorityDomains.indexOf(a.entity_fingerprint?.domain as string);
      const bIndex = priorityDomains.indexOf(b.entity_fingerprint?.domain as string);
      const aPriority = aIndex === -1 ? 999 : aIndex;
      const bPriority = bIndex === -1 ? 999 : bIndex;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.confidence - a.confidence;
    });
    const preferred = sorted[0]?.entity_fingerprint?.entity_id;
    if (!preferred) continue;
    for (const entry of entityList) {
      const resolution = byEntity[entry.entity_id];
      if (resolution) {
        resolution.preferred_control_entity = preferred;
      }
    }
    if (byDevice[deviceId]) {
      byDevice[deviceId].preferred_control_entity = preferred;
    }
  }
  return { by_entity: byEntity, by_device: byDevice, needs_override: needsOverride };
};

type SemanticActionStats = {
  success_count: number;
  fail_count: number;
  last_success_ts?: string;
  last_fail_ts?: string;
  last_reason?: string;
};

type LearnedSemanticEntry = {
  semantic_type: string;
  control_model: string;
  success_count: number;
  last_success_ts?: string;
  last_failure_ts?: string;
  last_intent?: string;
  promotion_threshold?: number;
  device_fingerprint?: string;
};

type LearnedAliasEntry = {
  alias: string;
  entity_id: string;
  device_id?: string;
  semantic_type: string;
  confidence: number;
  success_count: number;
  last_success_ts?: string;
  last_intent?: string;
};

type LearnedSemanticStore = {
  entities: Record<string, LearnedSemanticEntry>;
  aliases: Record<string, LearnedAliasEntry>;
  fingerprints: Record<string, LearnedSemanticEntry>;
  meta?: { promotion_threshold?: number; updated_at?: string };
};

type ReliabilityStatsEntry = {
  attempts: number;
  ok: number;
  last_ok_ts?: string;
  last_fail_ts?: string;
  avg_latency_ms?: number;
  typical_verification_level?: VerificationLevel;
  most_reliable_service?: string;
  last_result?: string;
};

type RiskApprovalEntry = {
  approved: boolean;
  ts: string;
  entity_id: string;
  action_kind: string;
  note?: string;
};

type RiskPolicyDecision = "auto_approve" | "confirm" | "readonly_only" | "deny";

type RiskPolicyBounds = {
  min?: number;
  max?: number;
  max_delta?: number;
  allowed_modes?: string[];
};

type RiskPolicyConditions = {
  time_window?: { start: string; end: string };
  cooldown_seconds?: number;
};

type RiskPolicyRule = {
  rule_id: string;
  scope: "global" | "area" | "device" | "entity";
  id: string;
  domain: string;
  action: string;
  decision: RiskPolicyDecision;
  bounds?: RiskPolicyBounds;
  conditions?: RiskPolicyConditions;
  note?: string;
  force?: boolean;
};

type RiskPolicyDefaults = Record<string, Record<string, { decision: RiskPolicyDecision; bounds?: RiskPolicyBounds }>>;

type RiskPolicy = {
  version: number;
  rules: RiskPolicyRule[];
  defaults: RiskPolicyDefaults;
};

type RiskPolicyState = {
  last_action_ts: Record<string, string>;
};

type RiskPolicyEvaluation = {
  decision: RiskPolicyDecision;
  reasons: string[];
  matched_rule?: RiskPolicyRule;
  action_key: string;
};

const loadSemanticStats = async () => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(SEMANTIC_STATS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, SemanticActionStats>;
    }
  } catch {
    // ignore
  }
  return {} as Record<string, SemanticActionStats>;
};

const saveSemanticStats = async (stats: Record<string, SemanticActionStats>) => {
  await ensureSemanticDataDir();
  await writeFile(SEMANTIC_STATS_PATH, JSON.stringify(stats, null, 2));
};

const updateSemanticStats = async (key: string, ok: boolean, reason: string) => {
  const stats = await loadSemanticStats();
  const current = stats[key] ?? { success_count: 0, fail_count: 0 };
  if (ok) {
    current.success_count += 1;
    current.last_success_ts = new Date().toISOString();
  } else {
    current.fail_count += 1;
    current.last_fail_ts = new Date().toISOString();
    current.last_reason = reason;
  }
  stats[key] = current;
  await saveSemanticStats(stats);
  return current;
};

const normalizeLearnedStore = (parsed: unknown): LearnedSemanticStore => {
  const empty: LearnedSemanticStore = { entities: {}, aliases: {}, fingerprints: {} };
  if (!parsed || typeof parsed !== "object") return empty;
  const record = parsed as Record<string, unknown>;
  if (record.entities && typeof record.entities === "object") {
    const entities = record.entities as Record<string, LearnedSemanticEntry>;
    const aliases =
      record.aliases && typeof record.aliases === "object"
        ? (record.aliases as Record<string, LearnedAliasEntry>)
        : {};
    const fingerprints =
      record.fingerprints && typeof record.fingerprints === "object"
        ? (record.fingerprints as Record<string, LearnedSemanticEntry>)
        : {};
    const meta = record.meta && typeof record.meta === "object" ? (record.meta as LearnedSemanticStore["meta"]) : undefined;
    return { entities, aliases, fingerprints, meta };
  }
  return { entities: record as Record<string, LearnedSemanticEntry>, aliases: {}, fingerprints: {} };
};

const loadLearnedSemanticMap = async (): Promise<LearnedSemanticStore> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(SEMANTIC_LEARNED_PATH, "utf8");
    return normalizeLearnedStore(JSON.parse(raw));
  } catch {
    // ignore
  }
  return { entities: {}, aliases: {}, fingerprints: {} };
};

const saveLearnedSemanticMap = async (store: LearnedSemanticStore) => {
  await ensureSemanticDataDir();
  await writeFile(SEMANTIC_LEARNED_PATH, JSON.stringify(store, null, 2));
};

const updateLearnedSemanticMap = async (input: {
  entityId: string;
  semanticType: string;
  controlModel: string;
  intentLabel: string;
  ok: boolean;
  deviceFingerprint?: string;
}) => {
  const store = await loadLearnedSemanticMap();
  store.meta = {
    promotion_threshold: LEARNED_SUCCESS_THRESHOLD,
    updated_at: new Date().toISOString(),
  };
  const entry = store.entities[input.entityId] ?? {
    semantic_type: input.semanticType,
    control_model: input.controlModel,
    success_count: 0,
  };
  if (input.ok) {
    entry.semantic_type = input.semanticType;
    entry.control_model = input.controlModel;
    entry.success_count += 1;
    entry.last_success_ts = new Date().toISOString();
    entry.last_intent = input.intentLabel;
  } else {
    entry.last_failure_ts = new Date().toISOString();
    entry.last_intent = input.intentLabel;
  }
  entry.promotion_threshold = LEARNED_SUCCESS_THRESHOLD;
  store.entities[input.entityId] = entry;
  let fingerprintEntry: LearnedSemanticEntry | null = null;
  if (input.deviceFingerprint) {
    fingerprintEntry = store.fingerprints[input.deviceFingerprint] ?? {
      semantic_type: input.semanticType,
      control_model: input.controlModel,
      success_count: 0,
    };
    if (input.ok) {
      fingerprintEntry.semantic_type = input.semanticType;
      fingerprintEntry.control_model = input.controlModel;
      fingerprintEntry.success_count += 1;
      fingerprintEntry.last_success_ts = new Date().toISOString();
      fingerprintEntry.last_intent = input.intentLabel;
    } else {
      fingerprintEntry.last_failure_ts = new Date().toISOString();
      fingerprintEntry.last_intent = input.intentLabel;
    }
    fingerprintEntry.promotion_threshold = LEARNED_SUCCESS_THRESHOLD;
    fingerprintEntry.device_fingerprint = input.deviceFingerprint;
    store.fingerprints[input.deviceFingerprint] = fingerprintEntry;
  }
  await saveLearnedSemanticMap(store);
  return { entity: entry, fingerprint: fingerprintEntry, promotion_threshold: LEARNED_SUCCESS_THRESHOLD };
};

const normalizeAliasKey = (value: string) => normalizeName(value);

const updateLearnedAliasMap = async (input: {
  alias: string;
  entityId: string;
  deviceId?: string;
  semanticType: string;
  intentLabel: string;
  ok: boolean;
}) => {
  if (!input.ok) return null;
  const key = normalizeAliasKey(input.alias);
  if (!key) return null;
  const store = await loadLearnedSemanticMap();
  const entry = store.aliases[key] ?? {
    alias: input.alias,
    entity_id: input.entityId,
    device_id: input.deviceId,
    semantic_type: input.semanticType,
    confidence: 0.6,
    success_count: 0,
  };
  entry.alias = input.alias;
  entry.entity_id = input.entityId;
  entry.device_id = input.deviceId;
  entry.semantic_type = input.semanticType;
  entry.success_count += 1;
  entry.last_success_ts = new Date().toISOString();
  entry.last_intent = input.intentLabel;
  entry.confidence = Math.min(1, 0.5 + entry.success_count * 0.15);
  store.aliases[key] = entry;
  await saveLearnedSemanticMap(store);
  return entry;
};

const resolveLearnedAlias = (alias: string, store: LearnedSemanticStore) => {
  const key = normalizeAliasKey(alias);
  if (!key) return null;
  return store.aliases[key] ?? null;
};

const loadReliabilityStats = async (): Promise<Record<string, ReliabilityStatsEntry>> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(RELIABILITY_STATS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, ReliabilityStatsEntry>;
    }
  } catch {
    // ignore
  }
  return {};
};

const saveReliabilityStats = async (stats: Record<string, ReliabilityStatsEntry>) => {
  await ensureSemanticDataDir();
  await writeFile(RELIABILITY_STATS_PATH, JSON.stringify(stats, null, 2));
};

const updateReliabilityStats = async (input: {
  entityId: string;
  actionKind: string;
  ok: boolean;
  latencyMs: number;
  verificationLevel: VerificationLevel;
  serviceVariant: string;
}) => {
  const stats = await loadReliabilityStats();
  const key = `${input.entityId}:${input.actionKind}`;
  const current = stats[key] ?? { attempts: 0, ok: 0 };
  current.attempts += 1;
  if (input.ok) {
    current.ok += 1;
    current.last_ok_ts = new Date().toISOString();
  } else {
    current.last_fail_ts = new Date().toISOString();
  }
  const prevAvg = current.avg_latency_ms ?? input.latencyMs;
  current.avg_latency_ms = Math.round((prevAvg * (current.attempts - 1) + input.latencyMs) / current.attempts);
  current.typical_verification_level = input.verificationLevel;
  current.most_reliable_service = input.serviceVariant;
  current.last_result = input.ok ? "ok" : "fail";
  stats[key] = current;
  await saveReliabilityStats(stats);
  return current;
};

const pickReliableService = async (input: {
  entityId: string;
  primary: { domain: string; service: string };
  fallbacks: Array<{ domain: string; service: string }>;
}) => {
  const stats = await loadReliabilityStats();
  const scoreFor = (domain: string, service: string) => {
    const entry = stats[`${input.entityId}:${domain}.${service}`];
    if (!entry || entry.attempts < 3) return null;
    return entry.ok / Math.max(1, entry.attempts);
  };
  const primaryScore = scoreFor(input.primary.domain, input.primary.service);
  let best = { domain: input.primary.domain, service: input.primary.service, score: primaryScore ?? 0 };
  for (const fallback of input.fallbacks) {
    const score = scoreFor(fallback.domain, fallback.service);
    if (score !== null && score > best.score + 0.2) {
      best = { domain: fallback.domain, service: fallback.service, score };
    }
  }
  return best.domain === input.primary.domain && best.service === input.primary.service ? null : best;
};

const loadRiskApprovals = async (): Promise<Record<string, RiskApprovalEntry>> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(RISK_APPROVALS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, RiskApprovalEntry>;
    }
  } catch {
    // ignore
  }
  return {};
};

const saveRiskApprovals = async (approvals: Record<string, RiskApprovalEntry>) => {
  await ensureSemanticDataDir();
  await writeFile(RISK_APPROVALS_PATH, JSON.stringify(approvals, null, 2));
};

const riskApprovalKey = (entityId: string, actionKind: string) => `${entityId}:${actionKind}`;

const hasRiskApproval = async (entityId: string, actionKind: string) => {
  const approvals = await loadRiskApprovals();
  return Boolean(approvals[riskApprovalKey(entityId, actionKind)]?.approved);
};

const recordRiskApproval = async (input: {
  entityId: string;
  actionKind: string;
  note?: string;
}) => {
  const approvals = await loadRiskApprovals();
  const key = riskApprovalKey(input.entityId, input.actionKind);
  approvals[key] = {
    approved: true,
    ts: new Date().toISOString(),
    entity_id: input.entityId,
    action_kind: input.actionKind,
    note: input.note,
  };
  await saveRiskApprovals(approvals);
  return approvals[key];
};

const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: 1,
  rules: [],
  defaults: {
    vacuum: {
      start: { decision: "auto_approve" },
      stop: { decision: "auto_approve" },
      return_to_base: { decision: "auto_approve" },
      pause: { decision: "auto_approve" },
      locate: { decision: "auto_approve" },
    },
    climate: {
      set_temperature: { decision: "auto_approve", bounds: { min: 18, max: 24, max_delta: 2 } },
      set_hvac_mode: { decision: "confirm" },
      set_preset_mode: { decision: "confirm" },
    },
    lock: {
      lock: { decision: "auto_approve" },
      unlock: { decision: "confirm" },
    },
    alarm_control_panel: {
      arm_home: { decision: "confirm" },
      arm_away: { decision: "confirm" },
      disarm: { decision: "confirm" },
    },
    "*": {
      "*": { decision: "confirm" },
    },
  },
};

const loadRiskPolicy = async (): Promise<RiskPolicy> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(RISK_POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as RiskPolicy;
    }
  } catch {
    // ignore
  }
  await ensureSemanticDataDir();
  await writeFile(RISK_POLICY_PATH, JSON.stringify(DEFAULT_RISK_POLICY, null, 2));
  return DEFAULT_RISK_POLICY;
};

const saveRiskPolicy = async (policy: RiskPolicy) => {
  await ensureSemanticDataDir();
  await writeFile(RISK_POLICY_PATH, JSON.stringify(policy, null, 2));
};

const loadRiskPolicyState = async (): Promise<RiskPolicyState> => {
  try {
    await ensureSemanticDataDir();
    const raw = await readFile(RISK_POLICY_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as RiskPolicyState;
    }
  } catch {
    // ignore
  }
  return { last_action_ts: {} };
};

const saveRiskPolicyState = async (state: RiskPolicyState) => {
  await ensureSemanticDataDir();
  await writeFile(RISK_POLICY_STATE_PATH, JSON.stringify(state, null, 2));
};

const recordRiskPolicyAction = async (entityId: string, actionKey: string) => {
  const state = await loadRiskPolicyState();
  state.last_action_ts[`${entityId}:${actionKey}`] = new Date().toISOString();
  await saveRiskPolicyState(state);
};

const normalizeActionKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/__+/g, "_")
    .trim();

const INVENTORY_ROUTE_TOKENS = [
  "inventar",
  "izvjestaj",
  "report",
  "needs_override",
  "needs override",
  "no_jebanci_score",
  "no jebanci score",
  "semantic map",
  "semantic_map",
];

const matchInventoryRouteTokens = (intent: string) => {
  const normalized = normalizeName(intent);
  const matched = INVENTORY_ROUTE_TOKENS.filter((token) => normalized.includes(normalizeName(token)));
  return { normalized, matched };
};

const resolveCanonicalActionKey = (input: {
  domain: string;
  service: string;
  intent?: { action?: string; property?: string };
}) => {
  const domain = normalizeName(input.domain);
  const service = normalizeActionKey(input.service);
  if (domain === "vacuum") {
    if (service === "start") return "start";
    if (service === "stop") return "stop";
    if (service === "return_to_base") return "return_to_base";
    if (service === "pause") return "pause";
    if (service === "locate") return "locate";
  }
  if (domain === "climate") {
    if (service === "set_temperature") return "set_temperature";
    if (service === "set_hvac_mode") return "set_hvac_mode";
    if (service === "set_preset_mode") return "set_preset_mode";
  }
  if (domain === "lock") {
    if (service === "lock") return "lock";
    if (service === "unlock") return "unlock";
  }
  if (domain === "alarm_control_panel") {
    if (service === "alarm_arm_home") return "arm_home";
    if (service === "alarm_arm_away") return "arm_away";
    if (service === "alarm_disarm") return "disarm";
  }
  if (domain === "cover") {
    if (service === "open_cover") return "open";
    if (service === "close_cover") return "close";
    if (service === "stop_cover") return "stop";
    if (service === "set_cover_position") return "set_position";
  }
  if (service) return service;
  return normalizeActionKey(input.intent?.action ?? "") || "unknown";
};

const normalizeRiskPolicyRule = (rule: RiskPolicyRule) => ({
  ...rule,
  scope: rule.scope,
  id: rule.id,
  domain: normalizeName(rule.domain || "*") || "*",
  action: normalizeActionKey(rule.action || "*") || "*",
});

const resolvePolicyDefault = (policy: RiskPolicy, domain: string, actionKey: string) => {
  const byDomain = policy.defaults[domain] ?? {};
  return (
    byDomain[actionKey] ??
    byDomain["*"] ??
    policy.defaults["*"]?.[actionKey] ??
    policy.defaults["*"]?.["*"] ??
    { decision: "confirm" as RiskPolicyDecision }
  );
};

const parseTimeWindow = (value?: { start: string; end: string }) => {
  if (!value?.start || !value?.end) return null;
  return { start: value.start, end: value.end };
};

const withinTimeWindow = (window: { start: string; end: string }, now: Date) => {
  const [startH, startM] = window.start.split(":").map((v) => Number(v));
  const [endH, endM] = window.end.split(":").map((v) => Number(v));
  if (!Number.isFinite(startH) || !Number.isFinite(startM) || !Number.isFinite(endH) || !Number.isFinite(endM)) {
    return true;
  }
  const minutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes <= endMinutes) {
    return minutes >= startMinutes && minutes <= endMinutes;
  }
  return minutes >= startMinutes || minutes <= endMinutes;
};

const extractRequestedTemperature = (payload: Record<string, unknown>) => {
  const temp = toNumberLoose(payload.temperature);
  if (temp !== undefined) return temp;
  const tempLow = toNumberLoose(payload.target_temp_low);
  const tempHigh = toNumberLoose(payload.target_temp_high);
  if (tempLow !== undefined && tempHigh !== undefined) return (tempLow + tempHigh) / 2;
  return undefined;
};

const isReliabilityWeak = (entry?: ReliabilityStatsEntry) => {
  if (!entry) return false;
  if (entry.attempts >= 3 && entry.ok / Math.max(1, entry.attempts) < 0.6) return true;
  if (entry.typical_verification_level === "ha_event") return true;
  if (entry.last_result === "fail") return true;
  return false;
};

const evaluateRiskPolicy = async (input: {
  policy: RiskPolicy;
  state: RiskPolicyState;
  target: InventoryEntity;
  actionPlan: { domain: string; service: string; payload: Record<string, unknown> };
  intent: { action?: string; property?: string };
  currentState: HaState | null;
  reliabilityStats?: ReliabilityStatsEntry;
  isReadOnly?: boolean;
}) => {
  const reasons: string[] = [];
  const now = new Date();
  const domain = normalizeName(input.actionPlan.domain);
  const actionKey = resolveCanonicalActionKey({
    domain: input.actionPlan.domain,
    service: input.actionPlan.service,
    intent: input.intent,
  });

  if (input.isReadOnly) {
    return { decision: "auto_approve", reasons: ["read_only"], action_key: actionKey } satisfies RiskPolicyEvaluation;
  }

  const normalizedArea = normalizeName(input.target.area_name ?? "");
  const matchesScope = (rule: RiskPolicyRule) => {
    if (rule.scope === "global") return rule.id === "*" || rule.id === "";
    if (rule.scope === "area") return rule.id && normalizeName(rule.id) === normalizedArea;
    if (rule.scope === "device") return rule.id && rule.id === input.target.device_id;
    if (rule.scope === "entity") return rule.id && rule.id === input.target.entity_id;
    return false;
  };

  const matchesRule = (rule: RiskPolicyRule) => {
    if (!matchesScope(rule)) return false;
    if (rule.domain !== "*" && rule.domain !== domain) return false;
    if (rule.action !== "*" && rule.action !== actionKey) return false;
    return true;
  };

  const evaluateBounds = (bounds?: RiskPolicyBounds) => {
    if (!bounds) return { ok: true, reasons: [] as string[] };
    const boundsReasons: string[] = [];
    const requestedTemp = extractRequestedTemperature(input.actionPlan.payload);
    if (bounds.min !== undefined || bounds.max !== undefined || bounds.max_delta !== undefined) {
      if (requestedTemp === undefined) {
        boundsReasons.push("bounds:missing_value");
      } else {
        if (bounds.min !== undefined && requestedTemp < bounds.min) {
          boundsReasons.push("bounds:below_min");
        }
        if (bounds.max !== undefined && requestedTemp > bounds.max) {
          boundsReasons.push("bounds:above_max");
        }
        if (bounds.max_delta !== undefined && input.currentState) {
          const currentTemp = toNumberLoose(
            input.currentState.attributes?.["current_temperature"] ??
              input.currentState.attributes?.["temperature"],
          );
          if (currentTemp !== undefined && Math.abs(requestedTemp - currentTemp) > bounds.max_delta) {
            boundsReasons.push("bounds:delta_exceeded");
          }
        }
      }
    }
    if (bounds.allowed_modes && bounds.allowed_modes.length > 0) {
      const mode = normalizeName(String(input.actionPlan.payload.hvac_mode ?? input.actionPlan.payload.preset_mode ?? ""));
      if (mode && !bounds.allowed_modes.some((entry) => normalizeName(entry) === mode)) {
        boundsReasons.push("bounds:mode_not_allowed");
      }
    }
    return { ok: boundsReasons.length === 0, reasons: boundsReasons };
  };

  const evaluateConditions = (conditions?: RiskPolicyConditions) => {
    if (!conditions) return { ok: true, reasons: [] as string[] };
    const conditionReasons: string[] = [];
    const window = parseTimeWindow(conditions.time_window);
    if (window && !withinTimeWindow(window, now)) {
      conditionReasons.push("condition:outside_time_window");
    }
    if (conditions.cooldown_seconds) {
      const key = `${input.target.entity_id}:${actionKey}`;
      const lastTs = input.state.last_action_ts[key];
      if (lastTs) {
        const last = Date.parse(lastTs);
        if (Number.isFinite(last)) {
          const delta = (now.getTime() - last) / 1000;
          if (delta < conditions.cooldown_seconds) {
            conditionReasons.push("condition:cooldown_active");
          }
        }
      }
    }
    return { ok: conditionReasons.length === 0, reasons: conditionReasons };
  };

  for (const rawRule of input.policy.rules) {
    const rule = normalizeRiskPolicyRule(rawRule);
    if (!matchesRule(rule)) continue;
    const boundsCheck = evaluateBounds(rule.bounds);
    const conditionCheck = evaluateConditions(rule.conditions);
    reasons.push(`rule:${rule.rule_id}`);
    reasons.push(...boundsCheck.reasons, ...conditionCheck.reasons);
    let decision = rule.decision;
    if (!boundsCheck.ok || !conditionCheck.ok) {
      decision = "confirm";
    }
    if (decision === "auto_approve" && isReliabilityWeak(input.reliabilityStats) && !rule.force) {
      return {
        decision: "confirm",
        reasons: [...reasons, "reliability:weak"],
        matched_rule: rule,
        action_key: actionKey,
      } satisfies RiskPolicyEvaluation;
    }
    return { decision, reasons, matched_rule: rule, action_key: actionKey } satisfies RiskPolicyEvaluation;
  }

  const fallback = resolvePolicyDefault(input.policy, domain, actionKey);
  const boundsCheck = (() => {
    if (!fallback.bounds) return { ok: true, reasons: [] as string[] };
    return evaluateBounds(fallback.bounds);
  })();
  reasons.push(`default:${domain}.${actionKey}`);
  reasons.push(...boundsCheck.reasons);
  let decision = fallback.decision;
  if (!boundsCheck.ok) decision = "confirm";
  if (decision === "auto_approve" && isReliabilityWeak(input.reliabilityStats)) {
    decision = "confirm";
    reasons.push("reliability:weak");
  }
  return { decision, reasons, action_key: actionKey } satisfies RiskPolicyEvaluation;
};

const resolveTargetFromSnapshot = (input: {
  snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>;
  target: { entity_id?: string; name?: string; area?: string; device_id?: string; domain?: string };
  semanticMap?: Record<string, SemanticResolution>;
  intentProperty?: string;
  learnedStore?: LearnedSemanticStore;
}) => {
  if (input.target.entity_id && input.snapshot.entities[input.target.entity_id]) {
    return input.snapshot.entities[input.target.entity_id];
  }
  if (input.target.name && input.learnedStore) {
    const learned = resolveLearnedAlias(input.target.name, input.learnedStore);
    if (learned?.entity_id && input.snapshot.entities[learned.entity_id]) {
      return input.snapshot.entities[learned.entity_id];
    }
  }
  const normalizedQuery = normalizeName(input.target.name ?? "");
  const normalizedArea = normalizeName(input.target.area ?? "");
  const normalizedDomain = normalizeName(input.target.domain ?? "");
  const candidates = Object.values(input.snapshot.entities).filter((entity) => {
    if (input.target.device_id && entity.device_id !== input.target.device_id) return false;
    if (normalizedDomain && normalizeName(entity.domain) !== normalizedDomain) return false;
    if (normalizedArea && normalizeName(entity.area_name) !== normalizedArea) return false;
    if (!normalizedQuery) return true;
    const haystack = normalizeName(
      `${entity.entity_id} ${entity.friendly_name} ${entity.original_name} ${entity.device_name}`,
    );
    return haystack.includes(normalizedQuery);
  });
  if (candidates.length === 0) return null;
  if (!input.semanticMap) return candidates[0];
  const intent = normalizeName(input.intentProperty ?? "");
  const scored = candidates.map((entity) => {
    const semantic = input.semanticMap?.[entity.entity_id];
    let score = semantic?.confidence ?? 0;
    if (intent === "brightness" && entity.domain === "light") {
      score += entity.attributes?.brightness !== undefined ? 0.2 : 0;
    }
    if (intent === "color" && entity.domain === "light") {
      score += Array.isArray(entity.attributes?.supported_color_modes) ? 0.2 : 0;
    }
    if (intent === "volume" && entity.domain === "media_player") {
      score += entity.attributes?.volume_level !== undefined ? 0.2 : 0;
    }
    if (intent === "temperature" && entity.domain === "climate") {
      score += entity.attributes?.temperature !== undefined ? 0.2 : 0;
    }
    if (intent === "percentage" && (entity.domain === "fan" || entity.domain === "cover")) {
      score += entity.attributes?.percentage !== undefined || entity.attributes?.current_position !== undefined ? 0.2 : 0;
    }
    return { entity, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.entity ?? candidates[0];
};

const pickActionTargetEntity = (input: {
  target: InventoryEntity;
  resolution: SemanticResolution;
  snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>;
  semanticMap: Record<string, SemanticResolution>;
}) => {
  if (!input.resolution.non_actionable && !isTelemetryDomain(input.target.domain)) {
    return input.target;
  }
  const preferred = input.resolution.preferred_control_entity;
  if (preferred && input.snapshot.entities[preferred]) {
    return input.snapshot.entities[preferred];
  }
  const deviceEntities = Object.values(input.snapshot.entities).filter(
    (entry) => entry.device_id && entry.device_id === input.target.device_id,
  );
  const vacuum = deviceEntities.find((entry) => entry.domain === "vacuum");
  if (vacuum) return vacuum;
  const actionable = deviceEntities.find(
    (entry) => !input.semanticMap[entry.entity_id]?.non_actionable && !isTelemetryDomain(entry.domain),
  );
  return actionable ?? input.target;
};

const buildUniversalPlan = (input: {
  entity: InventoryEntity;
  resolution: SemanticResolution;
  intent: { action?: string; value?: unknown; property?: string };
  data: Record<string, unknown>;
}) => {
  const payload = { ...input.data };
  if (input.intent.property && input.intent.value !== undefined) {
    payload[input.intent.property] = input.intent.value;
  }
  const action = normalizeName(input.intent.action ?? "");
  let service = "turn_on";
  let domain = input.entity.domain;

  if (domain === "light") {
    if (["turn_off", "off"].includes(action)) service = "turn_off";
    else if (["toggle"].includes(action)) service = "toggle";
    else service = "turn_on";
  } else if (domain === "media_player") {
    if (payload.volume !== undefined || payload.volume_level !== undefined || payload.volume_pct !== undefined) {
      service = "volume_set";
    } else if (["play", "pause", "stop", "next", "previous"].includes(action)) {
      service = action === "previous" ? "media_previous_track" : action === "next" ? "media_next_track" : `media_${action}`;
    } else {
      service = "media_play";
    }
  } else if (domain === "climate") {
    if (payload.temperature !== undefined || payload.temp !== undefined) {
      service = "set_temperature";
    } else if (["off"].includes(action)) {
      service = "set_hvac_mode";
      payload.hvac_mode = "off";
    } else {
      service = "set_temperature";
    }
  } else if (domain === "cover") {
    if (payload.position !== undefined || payload.position_pct !== undefined) {
      service = "set_cover_position";
    } else if (["open", "up"].includes(action)) {
      service = "open_cover";
    } else if (["close", "down"].includes(action)) {
      service = "close_cover";
    } else {
      service = "stop_cover";
    }
  } else if (domain === "fan") {
    if (payload.percentage !== undefined || payload.speed !== undefined) {
      service = "set_percentage";
    } else if (payload.preset_mode !== undefined) {
      service = "set_preset_mode";
    } else if (["off", "turn_off"].includes(action)) {
      service = "turn_off";
    } else {
      service = "turn_on";
    }
  } else if (domain === "switch") {
    if (["off", "turn_off"].includes(action)) service = "turn_off";
    else if (["toggle"].includes(action)) service = "toggle";
    else service = "turn_on";
  } else if (domain === "lock") {
    service = ["unlock"].includes(action) ? "unlock" : "lock";
  } else if (domain === "alarm_control_panel") {
    if (action.includes("disarm")) service = "alarm_disarm";
    else if (action.includes("away")) service = "alarm_arm_away";
    else service = "alarm_arm_home";
  } else if (domain === "vacuum") {
    service = action.includes("return") ? "return_to_base" : "start";
  } else if (domain === "number") {
    service = "set_value";
  } else if (domain === "select") {
    service = "select_option";
  } else if (domain === "input_boolean") {
    service = ["off", "turn_off"].includes(action) ? "turn_off" : "turn_on";
  } else if (domain === "scene" || domain === "script") {
    service = "turn_on";
  }

  const fallbacks: Array<{ domain: string; service: string; payload: Record<string, unknown>; reason: string }> = [];
  if (domain === "fan" && service === "set_percentage") {
    fallbacks.push({ domain, service: "turn_on", payload: {}, reason: "percentage_not_supported" });
  }
  if (domain === "switch" && payload.percentage !== undefined) {
    fallbacks.push({ domain, service, payload: {}, reason: "percentage_not_supported" });
  }
  if (domain === "light" && payload.color !== undefined) {
    fallbacks.push({ domain, service: "turn_on", payload: { brightness: payload.brightness ?? payload.brightness_pct }, reason: "color_not_supported" });
  }

  return { domain, service, payload, fallbacks };
};

const isSafeSwitchProbe = (entity: InventoryEntity, resolution: SemanticResolution) => {
  if (["outlet", "generic_switch"].includes(resolution.semantic_type)) {
    if (resolution.ambiguity.ok) return true;
    return resolution.confidence >= 0.6;
  }
  const name = normalizeName(`${entity.friendly_name} ${entity.original_name} ${entity.device_name}`);
  return ["outlet", "plug", "utičnica", "uticnica"].some((token) => name.includes(token));
};

const buildReversibleProbePlan = (
  entity: InventoryEntity,
  resolution: SemanticResolution,
  state: HaState | null,
) => {
  const domain = entity.domain;
  const attrs = (state?.attributes ?? {}) as Record<string, unknown>;
  if (domain === "light") {
    const beforeOn = state?.state === "on";
    const beforeBrightness = toNumberLoose(attrs["brightness"]);
    const actionPayload: Record<string, unknown> = { brightness: 1 };
    const restorePayload: Record<string, unknown> = beforeBrightness !== undefined ? { brightness: beforeBrightness } : {};
    return {
      action: { domain: "light", service: "turn_on", payload: actionPayload },
      restore: beforeOn
        ? { domain: "light", service: "turn_on", payload: restorePayload }
        : { domain: "light", service: "turn_off", payload: {} },
    };
  }
  if (domain === "fan") {
    const beforeOn = state?.state === "on";
    const beforePct = toNumberLoose(attrs["percentage"]);
    if (beforePct !== undefined) {
      return {
        action: { domain: "fan", service: "set_percentage", payload: { percentage: 10 } },
        restore: { domain: "fan", service: "set_percentage", payload: { percentage: beforePct } },
      };
    }
    return {
      action: { domain: "fan", service: "turn_on", payload: {} },
      restore: beforeOn ? { domain: "fan", service: "turn_on", payload: {} } : { domain: "fan", service: "turn_off", payload: {} },
    };
  }
  if (domain === "switch" && isSafeSwitchProbe(entity, resolution)) {
    const beforeOn = state?.state === "on";
    return {
      action: { domain: "switch", service: beforeOn ? "turn_off" : "turn_on", payload: {} },
      restore: { domain: "switch", service: beforeOn ? "turn_on" : "turn_off", payload: {} },
    };
  }
  return null;
};

const runReversibleProbe = async (
  entity: InventoryEntity,
  resolution: SemanticResolution,
  verifyTimeoutMs?: number,
) => {
  const beforeState = await fetchEntityState(entity.entity_id);
  const plan = buildReversibleProbePlan(entity, resolution, beforeState);
  if (!plan) {
    return {
      ok: false,
      verification: buildEmptyVerification("probe_not_safe", [entity.entity_id]),
      restore_verification: null,
      before: beforeState,
      after: beforeState,
      reason: "probe_not_safe",
    };
  }
  const allowEventVerification = isLowRiskVerificationTarget(resolution.semantic_type, entity.domain);
  const actionPayload = buildServicePayload({ entity_id: [entity.entity_id] }, plan.action.payload);
  const actionResult = await executeServiceCallWithVerification({
    domain: plan.action.domain,
    service: plan.action.service,
    payload: actionPayload,
    entityIds: [entity.entity_id],
    verifyTimeoutMs,
    wsTimeoutMs: verifyTimeoutMs,
    allowEventVerification,
  });
  await sleep(250);
  const restorePayload = buildServicePayload({ entity_id: [entity.entity_id] }, plan.restore.payload);
  const restoreResult = await executeServiceCallWithVerification({
    domain: plan.restore.domain,
    service: plan.restore.service,
    payload: restorePayload,
    entityIds: [entity.entity_id],
    verifyTimeoutMs,
    wsTimeoutMs: verifyTimeoutMs,
    allowEventVerification,
  });
  const afterState = await fetchEntityState(entity.entity_id);
  const ok = actionResult.verification.ok && restoreResult.verification.ok;
  const restoreReason =
    ok && restoreResult.verification.level === "ha_event" ? "verified_restore_event" : ok ? "verified_restore" : "restore_failed";
  return {
    ok,
    verification: {
      attempted: true,
      ok,
      level: restoreResult.verification.level,
      method: restoreResult.verification.method,
      reason: restoreReason,
      targets: [entity.entity_id],
      before: beforeState ? { [entity.entity_id]: beforeState } : null,
      after: afterState ? { [entity.entity_id]: afterState } : null,
      evidence: {
        probe: actionResult.verification,
        restore: restoreResult.verification,
      },
    } satisfies VerificationResult,
    restore_verification: restoreResult.verification,
    before: beforeState,
    after: afterState,
    reason: ok ? "ok" : "restore_failed",
  };
};

const coerceLightListFields = (fields?: string[]) => {
  const allowed = new Set(LIGHT_LIST_DEFAULT_FIELDS);
  const selected = (fields ?? []).filter((field) => allowed.has(field));
  if (selected.length === 0) return LIGHT_LIST_DEFAULT_FIELDS;
  return selected;
};

const buildAreaLightRow = (input: {
  entity: RegistryEntity;
  state: HaState | undefined;
  friendly_name: string;
}) => {
  const attributes = (input.state?.attributes ?? {}) as Record<string, unknown>;
  return {
    entity_id: input.entity.entity_id,
    name: input.friendly_name,
    friendly_name: input.friendly_name,
    state: input.state?.state ?? null,
    supported_color_modes: Array.isArray(attributes["supported_color_modes"])
      ? (attributes["supported_color_modes"] as string[])
      : [],
    brightness: toNumber(attributes["brightness"]) ?? null,
    color_mode: safeString(attributes["color_mode"]) || null,
    color_temp_kelvin: toNumber(attributes["color_temp_kelvin"]) ?? null,
  };
};

const pickAreaLightFields = (
  row: ReturnType<typeof buildAreaLightRow>,
  fields: string[],
) => {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "color_temp_kelvin" && row.color_temp_kelvin === null) continue;
    output[field] = (row as Record<string, unknown>)[field];
  }
  return output;
};

const listDuplicatesByArea = (rows: Array<{ area_name: string; friendly_name: string; entity_id: string }>) => {
  const grouped = new Map<string, { area_name: string; friendly_name: string; entity_ids: string[] }>();
  for (const row of rows) {
    const areaKey = normalizeName(row.area_name || "unknown");
    const nameKey = normalizeName(row.friendly_name || row.entity_id);
    if (!nameKey) continue;
    const key = `${areaKey}:${nameKey}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.entity_ids.push(row.entity_id);
    } else {
      grouped.set(key, {
        area_name: row.area_name || "unknown",
        friendly_name: row.friendly_name || row.entity_id,
        entity_ids: [row.entity_id],
      });
    }
  }
  return Array.from(grouped.values()).filter((entry) => entry.entity_ids.length > 1);
};

const buildSimilarityReport = (
  rows: Array<{ area_name: string; friendly_name: string; entity_id: string }>,
) => {
  const report: Array<{
    area_name: string;
    name_a: string;
    name_b: string;
    entity_ids: string[];
  }> = [];
  const byArea = new Map<string, Array<{ name: string; entity_id: string }>>();
  for (const row of rows) {
    const key = row.area_name || "unknown";
    const list = byArea.get(key) ?? [];
    list.push({ name: row.friendly_name || row.entity_id, entity_id: row.entity_id });
    byArea.set(key, list);
  }
  for (const [areaName, list] of byArea.entries()) {
    const normalized = list.map((item) => ({ ...item, norm: normalizeName(item.name) }));
    for (let i = 0; i < normalized.length; i += 1) {
      for (let j = i + 1; j < normalized.length; j += 1) {
        const a = normalized[i];
        const b = normalized[j];
        if (!a.norm || !b.norm || a.norm === b.norm) continue;
        const similar = a.norm.includes(b.norm) || b.norm.includes(a.norm);
        if (!similar) continue;
        report.push({
          area_name: areaName,
          name_a: a.name,
          name_b: b.name,
          entity_ids: [a.entity_id, b.entity_id],
        });
      }
    }
  }
  return report;
};

const buildGenericTermReport = (
  rows: Array<{ friendly_name: string; entity_id: string }>,
) => {
  const terms = ["lamp", "light", "fan", "switch"];
  const report: Array<{ term: string; candidates: string[] }> = [];
  for (const term of terms) {
    const matches = rows
      .filter((row) => normalizeName(row.friendly_name || row.entity_id).includes(term))
      .map((row) => row.entity_id);
    if (matches.length > 1) {
      report.push({ term, candidates: matches });
    }
  }
  return report;
};

const summarizeServices = (services: HaServices) => {
  const summary: Record<string, string[]> = {};
  for (const [domain, domainServices] of Object.entries(services)) {
    summary[domain] = Object.keys(domainServices).sort();
  }
  return summary;
};

const buildIndexes = (
  areas: RegistryArea[],
  devices: RegistryDevice[],
  entities: RegistryEntity[],
  statesById: Map<string, HaState>,
) => {
  const areasById = buildAreasById(areas);
  const devicesById = buildDevicesById(devices);

  const byAreaId: Record<string, { area_id: string; area_name: string; entity_ids: string[]; device_ids: string[] }> =
    {};
  const byAreaName: Record<string, { area_id: string; area_name: string; entity_ids: string[]; device_ids: string[] }> =
    {};
  const byDeviceId: Record<string, { device_id: string; device_name: string; area_id: string; entity_ids: string[] }> =
    {};

  for (const device of devices) {
    byDeviceId[device.id] = {
      device_id: device.id,
      device_name: device.name,
      area_id: device.area_id,
      entity_ids: [],
    };
  }

  for (const entity of entities) {
    const areaId = resolveAreaIdForEntity(entity, devicesById);
    const areaName = areasById.get(areaId)?.name ?? "";
    if (!byAreaId[areaId]) {
      byAreaId[areaId] = {
        area_id: areaId,
        area_name: areaName,
        entity_ids: [],
        device_ids: [],
      };
    }
    byAreaId[areaId].entity_ids.push(entity.entity_id);
    if (entity.device_id) {
      byAreaId[areaId].device_ids.push(entity.device_id);
      if (byDeviceId[entity.device_id]) {
        byDeviceId[entity.device_id].entity_ids.push(entity.entity_id);
      }
    }
    if (areaName) {
      if (!byAreaName[areaName]) {
        byAreaName[areaName] = {
          area_id: areaId,
          area_name: areaName,
          entity_ids: [],
          device_ids: [],
        };
      }
      byAreaName[areaName].entity_ids.push(entity.entity_id);
      if (entity.device_id) {
        byAreaName[areaName].device_ids.push(entity.device_id);
      }
    }
  }

  const friendlyRows = entities.map((entity) => ({
    entity_id: entity.entity_id,
    friendly_name: resolveFriendlyName(entity, statesById),
    area_name: resolveAreaNameForEntity(entity, devicesById, areasById),
  }));

  const ambiguity_report = {
    duplicate_friendly_names: listDuplicatesByArea(friendlyRows),
    similar_names: buildSimilarityReport(friendlyRows),
    generic_terms: buildGenericTermReport(friendlyRows),
  };

  return {
    indexes: {
      by_area_name: byAreaName,
      by_area_id: byAreaId,
      by_device_id: byDeviceId,
    },
    ambiguity_report,
  };
};

const normalizeIdentifiers = (identifiers: string[][] | undefined) =>
  (identifiers ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map((pair) => `${safeString(pair[0])}:${safeString(pair[1])}`)
    .filter(Boolean)
    .sort();

const buildDeviceFingerprint = (input: {
  manufacturer: string;
  model: string;
  identifiers: string[][];
  entityUniqueIds: string[];
  entityIds: string[];
}) => {
  const uniqueIds = input.entityUniqueIds.filter(Boolean);
  const entityIds = uniqueIds.length > 0 ? uniqueIds : input.entityIds.filter(Boolean);
  const payload = {
    manufacturer: safeString(input.manufacturer),
    model: safeString(input.model),
    identifiers: normalizeIdentifiers(input.identifiers),
    entity_unique_ids: [...new Set(entityIds)].sort(),
  };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `sha256:${hash.slice(0, 24)}`;
};

const deviceGraphKeyForEntity = (entity: { device_id?: string; entity_id: string }) =>
  entity.device_id ? entity.device_id : `unknown:${entity.entity_id}`;

const buildDeviceGraph = (input: {
  areas: RegistryArea[];
  devices: RegistryDevice[];
  entities: RegistryEntity[];
}) => {
  const areasById = buildAreasById(input.areas);
  const devicesById = buildDevicesById(input.devices);
  const graph: Record<string, DeviceGraphEntry> = {};

  const ensureEntry = (deviceId: string, seed?: RegistryDevice) => {
    if (!graph[deviceId]) {
      const device = seed ?? devicesById.get(deviceId);
      const areaId = safeString(device?.area_id);
      graph[deviceId] = {
        device_id: deviceId,
        device_name: safeString(device?.name ?? ""),
        area_id: areaId,
        area_name: areaId ? safeString(areasById.get(areaId)?.name ?? "") : "",
        manufacturer: safeString(device?.manufacturer ?? ""),
        model: safeString(device?.model ?? ""),
        identifiers: device?.identifiers ?? [],
        via_device_id: safeString(device?.via_device_id ?? ""),
        entity_ids: [],
        entity_unique_ids: [],
        entity_domains: [],
        integration_domains: [],
        device_fingerprint: "",
      };
    }
    return graph[deviceId];
  };

  for (const device of input.devices) {
    ensureEntry(device.id, device);
  }

  for (const entity of input.entities) {
    const key = deviceGraphKeyForEntity(entity);
    const entry = ensureEntry(key);
    entry.entity_ids.push(entity.entity_id);
    if (entity.unique_id) entry.entity_unique_ids.push(entity.unique_id);
    const domain = entity.entity_id.split(".")[0] ?? "";
    if (domain) entry.entity_domains.push(domain);
    if (entity.platform) entry.integration_domains.push(entity.platform);
    if (!entry.area_id && entity.area_id) {
      entry.area_id = entity.area_id;
      entry.area_name = safeString(areasById.get(entity.area_id)?.name ?? "");
    }
  }

  for (const entry of Object.values(graph)) {
    entry.entity_ids = [...new Set(entry.entity_ids)].sort();
    entry.entity_unique_ids = [...new Set(entry.entity_unique_ids)].sort();
    entry.entity_domains = [...new Set(entry.entity_domains)].sort();
    entry.integration_domains = [...new Set(entry.integration_domains)].sort();
    entry.device_fingerprint = buildDeviceFingerprint({
      manufacturer: entry.manufacturer,
      model: entry.model,
      identifiers: entry.identifiers,
      entityUniqueIds: entry.entity_unique_ids,
      entityIds: entry.entity_ids,
    });
  }
  return graph;
};

const buildRegistrySnapshot = async () => {
  const [areasRes, devicesRes, entitiesRes, servicesRes, statesRes] = await Promise.all([
    wsCall("config/area_registry/list"),
    wsCall("config/device_registry/list"),
    wsCall("config/entity_registry/list"),
    fetchServices(),
    fetchStates(),
  ]);

  if (!areasRes.success) {
    throw new Error(`WS registry failure: config/area_registry/list ${JSON.stringify(areasRes.error ?? "")}`);
  }
  if (!devicesRes.success) {
    throw new Error(`WS registry failure: config/device_registry/list ${JSON.stringify(devicesRes.error ?? "")}`);
  }
  if (!entitiesRes.success) {
    throw new Error(`WS registry failure: config/entity_registry/list ${JSON.stringify(entitiesRes.error ?? "")}`);
  }
  if (!servicesRes.ok) {
    throw new Error("WS services failure: get_services");
  }
  if (!statesRes.ok || !Array.isArray(statesRes.data)) {
    throw new Error("REST states failure: /api/states");
  }

  const areas: RegistryArea[] = (areasRes.result as Array<Record<string, unknown>>).map((area) => ({
    area_id: safeString(area["area_id"]),
    name: safeString(area["name"]),
  }));
  const devices: RegistryDevice[] = (devicesRes.result as Array<Record<string, unknown>>).map((device) => ({
    id: safeString(device["id"] ?? device["device_id"]),
    name: safeString(device["name_by_user"] ?? device["name"]),
    area_id: safeString(device["area_id"]),
    model: safeString(device["model"]),
    manufacturer: safeString(device["manufacturer"]),
    identifiers: Array.isArray(device["identifiers"]) ? (device["identifiers"] as string[][]) : [],
    via_device_id: safeString(device["via_device_id"]),
  }));
  const entities: RegistryEntity[] = (entitiesRes.result as Array<Record<string, unknown>>).map((entity) => ({
    entity_id: safeString(entity["entity_id"]),
    unique_id: safeString(entity["unique_id"]),
    platform: safeString(entity["platform"]),
    area_id: safeString(entity["area_id"]),
    device_id: safeString(entity["device_id"]),
    name: safeString(entity["name"]),
    disabled_by: safeString(entity["disabled_by"]) || null,
    original_name: safeString(entity["original_name"]),
    original_device_class: safeString(entity["original_device_class"]),
    config_entry_id: safeString(entity["config_entry_id"]),
    entity_category: safeString(entity["entity_category"]) || null,
    device_class: safeString(entity["device_class"]) || null,
  }));

  const states = statesRes.data as HaState[];
  const statesById = buildStatesById(states);
  const services_summary = summarizeServices(servicesRes.data as HaServices);
  const { indexes, ambiguity_report } = buildIndexes(areas, devices, entities, statesById);

  return {
    areas,
    devices,
    entities,
    services_summary,
    indexes,
    ambiguity_report,
    states,
  };
};

const fetchInventorySnapshot = async () => {
  const notes: string[] = [];
  let areasRes: { success: boolean; result?: unknown; error?: unknown } = { success: false };
  try {
    areasRes = await wsCall("config/area_registry/list");
  } catch (err) {
    notes.push(`area_registry_unavailable:${String(err)}`);
  }
  const [devicesRes, entitiesRes] = await Promise.all([
    wsCall("config/device_registry/list"),
    wsCall("config/entity_registry/list"),
  ]);
  const statesRes = await requestJson({
    method: "GET",
    url: `${getHaBaseUrl()}/api/states`,
    token: getHaToken(),
  });
  const servicesRes = await requestJson({
    method: "GET",
    url: `${getHaBaseUrl()}/api/services`,
    token: getHaToken(),
  });

  if (!devicesRes.success) {
    throw new Error(`WS registry failure: config/device_registry/list ${JSON.stringify(devicesRes.error ?? "")}`);
  }
  if (!entitiesRes.success) {
    throw new Error(`WS registry failure: config/entity_registry/list ${JSON.stringify(entitiesRes.error ?? "")}`);
  }
  if (!statesRes.ok || !Array.isArray(statesRes.data)) {
    throw new Error(`REST states failure: /api/states ${statesRes.status ?? ""}`);
  }
  if (!servicesRes.ok) {
    throw new Error(`REST services failure: /api/services ${servicesRes.status ?? ""}`);
  }

  const areas: RegistryArea[] = areasRes.success
    ? (areasRes.result as Array<Record<string, unknown>>).map((area) => ({
        area_id: safeString(area["area_id"]),
        name: safeString(area["name"]),
      }))
    : [];
  if (!areasRes.success) {
    notes.push("area_registry_empty");
  }

  const devices: RegistryDevice[] = (devicesRes.result as Array<Record<string, unknown>>).map((device) => ({
    id: safeString(device["id"] ?? device["device_id"]),
    name: safeString(device["name_by_user"] ?? device["name"]),
    area_id: safeString(device["area_id"]),
    model: safeString(device["model"]),
    manufacturer: safeString(device["manufacturer"]),
    identifiers: Array.isArray(device["identifiers"]) ? (device["identifiers"] as string[][]) : [],
    via_device_id: safeString(device["via_device_id"]),
  }));
  const entities: RegistryEntity[] = (entitiesRes.result as Array<Record<string, unknown>>).map((entity) => ({
    entity_id: safeString(entity["entity_id"]),
    unique_id: safeString(entity["unique_id"]),
    platform: safeString(entity["platform"]),
    area_id: safeString(entity["area_id"]),
    device_id: safeString(entity["device_id"]),
    name: safeString(entity["name"]),
    disabled_by: safeString(entity["disabled_by"]) || null,
    original_name: safeString(entity["original_name"]),
    original_device_class: safeString(entity["original_device_class"]),
    config_entry_id: safeString(entity["config_entry_id"]),
    entity_category: safeString(entity["entity_category"]) || null,
    device_class: safeString(entity["device_class"]) || null,
  }));

  const states = statesRes.data as HaState[];
  const statesById = buildStatesById(states);
  const services = normalizeServicesFromRest(servicesRes.data) ?? {};
  const areasById = buildAreasById(areas);
  const devicesById = buildDevicesById(devices);
  const deviceGraph = buildDeviceGraph({ areas, devices, entities });

  const entitiesById: Record<string, InventoryEntity> = {};
  for (const entity of entities) {
    const state = statesById.get(entity.entity_id);
    const friendlyName = resolveFriendlyName(entity, statesById);
    const device = entity.device_id ? devicesById.get(entity.device_id) : undefined;
    const areaId = resolveAreaIdForEntity(entity, devicesById);
    const areaName = areasById.get(areaId)?.name ?? "";
    const aliasesRaw = (entity as unknown as Record<string, unknown>)["aliases"];
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.map((entry) => safeString(entry)).filter(Boolean)
      : [];
    const domain = entity.entity_id.split(".")[0] ?? "";
    const graphKey = deviceGraphKeyForEntity(entity);
    const graphEntry = deviceGraph[graphKey];
    entitiesById[entity.entity_id] = {
      domain,
      entity_id: entity.entity_id,
      friendly_name: friendlyName,
      original_name: entity.original_name ?? "",
      aliases,
      device_id: entity.device_id,
      area_id: areaId,
      area_name: areaName,
      device_name: device?.name ?? "",
      manufacturer: device?.manufacturer ?? "",
      model: device?.model ?? "",
      device_fingerprint: graphEntry?.device_fingerprint ?? "",
      integration: entity.platform ?? "",
      platform: entity.platform ?? "",
      state: state?.state ?? undefined,
      device_class: safeString(state?.attributes?.["device_class"] ?? entity.device_class) || null,
      original_device_class: entity.original_device_class ?? "",
      config_entry_id: entity.config_entry_id ?? "",
      entity_category: entity.entity_category ?? null,
      disabled_by: entity.disabled_by ?? null,
      unique_id: entity.unique_id ?? "",
      device_identifiers: device?.identifiers ?? [],
      via_device_id: device?.via_device_id ?? "",
      attributes: (state?.attributes ?? {}) as Record<string, unknown>,
      capabilities_hints: buildCapabilityHints(domain, (state?.attributes ?? {}) as Record<string, unknown>),
      services: Object.keys(services[domain] ?? {}),
    };
  }

  return {
    generated_at: new Date().toISOString(),
    notes,
    registry: {
      areas,
      devices,
      entities,
    },
    device_graph: deviceGraph,
    entities: entitiesById,
    services_by_domain: Object.fromEntries(
      Object.entries(services).map(([domain, definition]) => [domain, Object.keys(definition ?? {})]),
    ),
  };
};

const describeCapability = (entityId: string, state?: HaState) => {
  const domain = entityId.split(".")[0] ?? "";
  const attributes = (state?.attributes ?? {}) as Record<string, unknown>;
  const supportedFeatures = attributes["supported_features"];
  const derived: string[] = [];
  if (domain === "light") {
    if (attributes["brightness"] !== undefined) derived.push("brightness");
    if (attributes["color_temp"] !== undefined || attributes["min_mireds"] !== undefined) {
      derived.push("color_temp");
    }
    if (attributes["rgb_color"] !== undefined || attributes["hs_color"] !== undefined) {
      derived.push("color");
    }
    if (Array.isArray(attributes["effect_list"]) && (attributes["effect_list"] as unknown[]).length > 0) {
      derived.push("effect");
    }
  }
  if (domain === "climate") {
    if (Array.isArray(attributes["hvac_modes"])) derived.push("hvac_modes");
    if (Array.isArray(attributes["fan_modes"])) derived.push("fan_modes");
    if (Array.isArray(attributes["preset_modes"])) derived.push("preset_modes");
    if (attributes["temperature"] !== undefined) derived.push("temperature");
    if (attributes["target_temp_low"] !== undefined || attributes["target_temp_high"] !== undefined) {
      derived.push("temp_range");
    }
  }
  if (domain === "fan") {
    if (Array.isArray(attributes["preset_modes"])) derived.push("preset_modes");
    if (attributes["percentage"] !== undefined) derived.push("percentage");
  }
  if (domain === "cover") {
    if (attributes["current_position"] !== undefined) derived.push("position");
  }
  return {
    domain,
    supported_features: supportedFeatures ?? null,
    attributes_relevant: attributes,
    derived_capabilities: derived,
  };
};

const buildCapabilityHints = (domain: string, attributes: Record<string, unknown>) => {
  if (domain === "light") {
    return {
      supported_color_modes: Array.isArray(attributes["supported_color_modes"])
        ? attributes["supported_color_modes"]
        : [],
      color_mode: attributes["color_mode"] ?? null,
      min_mireds: attributes["min_mireds"] ?? null,
      max_mireds: attributes["max_mireds"] ?? null,
      brightness: attributes["brightness"] ?? null,
    };
  }
  if (domain === "fan") {
    return {
      percentage: attributes["percentage"] ?? null,
      percentage_step: attributes["percentage_step"] ?? null,
      preset_modes: Array.isArray(attributes["preset_modes"]) ? attributes["preset_modes"] : [],
    };
  }
  if (domain === "media_player") {
    return {
      volume_level: attributes["volume_level"] ?? null,
      is_volume_muted: attributes["is_volume_muted"] ?? null,
      source_list: Array.isArray(attributes["source_list"]) ? attributes["source_list"] : [],
    };
  }
  if (domain === "climate") {
    return {
      hvac_modes: Array.isArray(attributes["hvac_modes"]) ? attributes["hvac_modes"] : [],
      preset_modes: Array.isArray(attributes["preset_modes"]) ? attributes["preset_modes"] : [],
      min_temp: attributes["min_temp"] ?? null,
      max_temp: attributes["max_temp"] ?? null,
      target_temp_step: attributes["target_temp_step"] ?? null,
      supported_features: attributes["supported_features"] ?? null,
    };
  }
  if (domain === "cover") {
    return {
      current_position: attributes["current_position"] ?? null,
      supported_features: attributes["supported_features"] ?? null,
    };
  }
  if (domain === "number") {
    return {
      min: attributes["min"] ?? null,
      max: attributes["max"] ?? null,
      step: attributes["step"] ?? null,
    };
  }
  if (domain === "select") {
    return {
      options: Array.isArray(attributes["options"]) ? attributes["options"] : [],
    };
  }
  return {};
};

const READONLY_DOMAINS = new Set(["sensor", "binary_sensor", "device_tracker", "person"]);

const serviceExists = (services: HaServices | null, domain: string, service: string) =>
  Boolean(services?.[domain]?.[service]);

const matchOption = (options: string[], requested: string) => {
  const normalized = normalizeName(requested);
  if (!normalized) return null;
  const exact = options.find((option) => normalizeName(option) === normalized);
  if (exact) return exact;
  const partial = options.find((option) => {
    const normalizedOption = normalizeName(option);
    return normalizedOption.includes(normalized) || normalized.includes(normalizedOption);
  });
  return partial ?? null;
};

const pickFallbackOption = (options: string[]) => {
  if (options.includes("auto")) return "auto";
  if (options.includes("heat_cool")) return "heat_cool";
  return options[0] ?? "";
};

const normalizeMediaPlayerCall = (input: {
  service: string;
  payload: Record<string, unknown>;
  state: HaState | null;
  services: HaServices | null;
}) => {
  let service = input.service;
  const payload = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  let fallback: Record<string, unknown> | null = null;

  const serviceAlias = normalizeName(service);
  if (serviceAlias === "play") service = "media_play";
  if (serviceAlias === "pause") service = "media_pause";
  if (serviceAlias === "stop") service = "media_stop";
  if (serviceAlias === "next") service = "media_next_track";
  if (serviceAlias === "previous" || serviceAlias === "prev") service = "media_previous_track";

  const attrs = (input.state?.attributes ?? {}) as Record<string, unknown>;
  const sourceList = Array.isArray(attrs["source_list"]) ? (attrs["source_list"] as string[]) : [];
  const supportsVolume = attrs["volume_level"] !== undefined;
  const volumeLevelRaw = payload.volume_level;
  const volumeInput =
    payload.volume ??
    payload.volume_level ??
    payload.volume_pct ??
    payload.volume_percent ??
    payload.volume_percentage;
  const sourceInput = safeString(payload.source ?? payload.source_name ?? payload.app_name ?? "");
  const commandInput = safeString(payload.command ?? payload.state ?? payload.action ?? "");

  if (volumeLevelRaw !== undefined) {
    const level = toNumberLoose(volumeLevelRaw);
    if (level !== undefined && level <= 1) {
      if (supportsVolume) {
        service = "volume_set";
        payload.volume_level = clampNumber(level, 0, 1);
        delete payload.volume;
        delete payload.volume_pct;
        delete payload.volume_percent;
        delete payload.volume_percentage;
      } else {
        fallback = {
          reason: "volume_not_supported",
          requested: level,
        };
      }
    }
  }
  if (volumeInput !== undefined && payload.volume_level === undefined) {
    const volumePercent = parsePercentValue(volumeInput);
    if (volumePercent !== undefined) {
      if (supportsVolume) {
        service = "volume_set";
        payload.volume_level = clampNumber(volumePercent / 100, 0, 1);
        delete payload.volume;
        delete payload.volume_pct;
        delete payload.volume_percent;
        delete payload.volume_percentage;
      } else {
        fallback = {
          reason: "volume_not_supported",
          requested: volumeInput,
        };
      }
    }
  }
  if (fallback?.reason === "volume_not_supported") {
    if (serviceExists(input.services, "media_player", "media_play")) {
      service = "media_play";
    } else if (serviceExists(input.services, "media_player", "media_pause")) {
      service = "media_pause";
    }
    delete payload.volume_level;
    delete payload.volume;
    delete payload.volume_pct;
    delete payload.volume_percent;
    delete payload.volume_percentage;
  }

  if (sourceInput) {
    const matched = matchOption(sourceList, sourceInput);
    if (matched) {
      service = "select_source";
      payload.source = matched;
    } else if (sourceList.length > 0) {
      fallback = {
        reason: "source_not_supported",
        requested: sourceInput,
        available: sourceList,
      };
      if (serviceExists(input.services, "media_player", "media_play")) {
        service = "media_play";
      } else if (serviceExists(input.services, "media_player", "media_pause")) {
        service = "media_pause";
      }
    } else {
      unsupported.push("source");
    }
  }

  if (!sourceInput && commandInput) {
    const normalized = normalizeName(commandInput);
    if (["play", "start"].includes(normalized)) service = "media_play";
    if (["pause", "paused"].includes(normalized)) service = "media_pause";
    if (["stop"].includes(normalized)) service = "media_stop";
    if (["next", "skip"].includes(normalized)) service = "media_next_track";
    if (["previous", "prev", "back"].includes(normalized)) service = "media_previous_track";
  }

  if (!serviceExists(input.services, "media_player", service)) {
    warnings.push(`service_not_available:${service}`);
  }

  return { service, payload, warnings, unsupported, fallback };
};

const normalizeClimateCall = (input: {
  service: string;
  payload: Record<string, unknown>;
  state: HaState | null;
  services: HaServices | null;
}) => {
  let service = input.service;
  const payload = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  let fallback: Record<string, unknown> | null = null;

  const attrs = (input.state?.attributes ?? {}) as Record<string, unknown>;
  const hvacModes = Array.isArray(attrs["hvac_modes"]) ? (attrs["hvac_modes"] as string[]) : [];
  const presetModes = Array.isArray(attrs["preset_modes"])
    ? (attrs["preset_modes"] as string[])
    : [];
  const minTemp = toNumberLoose(attrs["min_temp"]);
  const maxTemp = toNumberLoose(attrs["max_temp"]);

  const hvacModeInput = safeString(payload.hvac_mode ?? "");
  const presetModeInput = safeString(payload.preset_mode ?? "");
  const tempInput = toNumberLoose(payload.temperature);
  const tempLowInput = toNumberLoose(payload.target_temp_low);
  const tempHighInput = toNumberLoose(payload.target_temp_high);

  if (hvacModeInput) {
    const matched = matchOption(hvacModes, hvacModeInput);
    if (matched) {
      service = "set_hvac_mode";
      payload.hvac_mode = matched;
    } else if (hvacModes.length > 0) {
      const fallbackMode = pickFallbackOption(hvacModes);
      if (fallbackMode) {
        service = "set_hvac_mode";
        payload.hvac_mode = fallbackMode;
        fallback = {
          reason: "hvac_mode_not_supported",
          requested: hvacModeInput,
          applied: fallbackMode,
          available: hvacModes,
        };
      }
    } else {
      unsupported.push("hvac_mode");
    }
  } else if (presetModeInput) {
    const matched = matchOption(presetModes, presetModeInput);
    if (matched) {
      service = "set_preset_mode";
      payload.preset_mode = matched;
    } else if (presetModes.length > 0) {
      const fallbackMode = pickFallbackOption(presetModes);
      if (fallbackMode) {
        service = "set_preset_mode";
        payload.preset_mode = fallbackMode;
        fallback = {
          reason: "preset_mode_not_supported",
          requested: presetModeInput,
          applied: fallbackMode,
          available: presetModes,
        };
      }
    } else {
      unsupported.push("preset_mode");
    }
  } else if (tempInput !== undefined || tempLowInput !== undefined || tempHighInput !== undefined) {
    service = "set_temperature";
    if (tempInput !== undefined) {
      let temp = tempInput;
      if (minTemp !== undefined && maxTemp !== undefined) {
        temp = clampNumber(temp, minTemp, maxTemp);
      }
      payload.temperature = temp;
    }
    if (tempLowInput !== undefined) {
      let tempLow = tempLowInput;
      if (minTemp !== undefined && maxTemp !== undefined) {
        tempLow = clampNumber(tempLow, minTemp, maxTemp);
      }
      payload.target_temp_low = tempLow;
    }
    if (tempHighInput !== undefined) {
      let tempHigh = tempHighInput;
      if (minTemp !== undefined && maxTemp !== undefined) {
        tempHigh = clampNumber(tempHigh, minTemp, maxTemp);
      }
      payload.target_temp_high = tempHigh;
    }
  }

  if (!serviceExists(input.services, "climate", service)) {
    warnings.push(`service_not_available:${service}`);
  }

  return { service, payload, warnings, unsupported, fallback };
};

const normalizeCoverCall = (input: { service: string; payload: Record<string, unknown> }) => {
  let service = input.service;
  const payload = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  let fallback: Record<string, unknown> | null = null;

  const serviceAlias = normalizeName(service);
  if (serviceAlias === "open") service = "open_cover";
  if (serviceAlias === "close") service = "close_cover";
  if (serviceAlias === "stop") service = "stop_cover";

  const positionInput =
    payload.position ?? payload.current_position ?? payload.position_pct ?? payload.position_percent;
  const position = parsePercentValue(positionInput);
  const commandInput = safeString(payload.command ?? payload.state ?? payload.action ?? "");

  if (position !== undefined) {
    service = "set_cover_position";
    payload.position = position;
  } else if (commandInput) {
    const normalized = normalizeName(commandInput);
    if (["open", "up", "raise"].includes(normalized)) service = "open_cover";
    if (["close", "down", "lower"].includes(normalized)) service = "close_cover";
    if (["stop", "halt"].includes(normalized)) service = "stop_cover";
  }

  return { service, payload, warnings, unsupported, fallback };
};

const normalizeFanCall = (input: { service: string; payload: Record<string, unknown>; state: HaState | null }) => {
  let service = input.service;
  const payload = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  let fallback: Record<string, unknown> | null = null;

  const serviceAlias = normalizeName(service);
  if (serviceAlias === "on") service = "turn_on";
  if (serviceAlias === "off") service = "turn_off";

  const attrs = (input.state?.attributes ?? {}) as Record<string, unknown>;
  const presetModes = Array.isArray(attrs["preset_modes"])
    ? (attrs["preset_modes"] as string[])
    : [];
  const supportsPercentage = attrs["percentage"] !== undefined;
  const percentageStep = toNumberLoose(attrs["percentage_step"]);

  const percentInput = payload.percentage ?? payload.speed ?? payload.speed_pct ?? payload.speed_percent;
  const presetInput = safeString(payload.preset_mode ?? "");
  const stateInput = safeString(payload.state ?? "");

  if (percentInput !== undefined) {
    const percent = parsePercentValue(percentInput);
    if (percent !== undefined && supportsPercentage) {
      service = "set_percentage";
      const adjusted =
        percentageStep && percentageStep > 0 ? Math.round(percent / percentageStep) * percentageStep : percent;
      payload.percentage = clampNumber(adjusted, 0, 100);
    } else if (presetModes.length > 0) {
      const fallbackMode = pickFallbackOption(presetModes);
      if (fallbackMode) {
        service = "set_preset_mode";
        payload.preset_mode = fallbackMode;
        fallback = {
          reason: "percentage_not_supported",
          requested: percentInput,
          applied: fallbackMode,
          available: presetModes,
        };
      }
    } else {
      unsupported.push("percentage");
      fallback = { reason: "capability_missing:percentage", requested: percentInput, applied: "turn_on" };
      service = "turn_on";
    }
  } else if (presetInput) {
    const matched = matchOption(presetModes, presetInput);
    if (matched) {
      service = "set_preset_mode";
      payload.preset_mode = matched;
    } else if (presetModes.length > 0) {
      const fallbackMode = pickFallbackOption(presetModes);
      if (fallbackMode) {
        service = "set_preset_mode";
        payload.preset_mode = fallbackMode;
        fallback = {
          reason: "preset_mode_not_supported",
          requested: presetInput,
          applied: fallbackMode,
          available: presetModes,
        };
      }
    } else {
      unsupported.push("preset_mode");
    }
  } else if (stateInput) {
    const normalized = normalizeName(stateInput);
    if (["on", "start"].includes(normalized)) service = "turn_on";
    if (["off", "stop"].includes(normalized)) service = "turn_off";
  }

  return { service, payload, warnings, unsupported, fallback };
};

const normalizeSwitchCall = (input: {
  service: string;
  payload: Record<string, unknown>;
  semanticType?: string;
}) => {
  let service = input.service;
  const payload = { ...input.payload };
  const warnings: string[] = [];
  const unsupported: string[] = [];
  let fallback: Record<string, unknown> | null = null;

  const serviceAlias = normalizeName(service);
  if (serviceAlias === "on") service = "turn_on";
  if (serviceAlias === "off") service = "turn_off";

  const stateInput = safeString(payload.state ?? payload.action ?? "");
  const fanInput = safeString(payload.fan ?? payload.fan_state ?? "");
  const percentInput = payload.percentage ?? payload.speed ?? payload.brightness;
  if (percentInput !== undefined) {
    unsupported.push("percentage");
    fallback = { reason: "capability_missing:percentage", requested: percentInput };
  }
  if (stateInput) {
    const normalized = normalizeName(stateInput);
    if (["on", "start"].includes(normalized)) service = "turn_on";
    if (["off", "stop"].includes(normalized)) service = "turn_off";
  }
  if (input.semanticType === "fan_switch" && fanInput) {
    const normalized = normalizeName(fanInput);
    if (["on", "start"].includes(normalized)) service = "turn_on";
    if (["off", "stop"].includes(normalized)) service = "turn_off";
    warnings.push("semantic_fan_switch");
  }

  return { service, payload, warnings, unsupported, fallback };
};

const normalizeFriendlyServiceCall = async (input: {
  domain: string;
  service: string;
  payload: Record<string, unknown>;
  entityIds: string[];
  semanticType?: string;
}) => {
  const servicesRes = await fetchServices();
  const services = servicesRes.ok ? (servicesRes.data as HaServices) : null;
  const state = input.entityIds[0] ? await fetchEntityState(input.entityIds[0]) : null;
  if (input.domain === "media_player") {
    return normalizeMediaPlayerCall({ service: input.service, payload: input.payload, state, services });
  }
  if (input.domain === "climate") {
    return normalizeClimateCall({ service: input.service, payload: input.payload, state, services });
  }
  if (input.domain === "cover") {
    return normalizeCoverCall({ service: input.service, payload: input.payload });
  }
  if (input.domain === "fan") {
    return normalizeFanCall({ service: input.service, payload: input.payload, state });
  }
  if (input.domain === "switch") {
    return normalizeSwitchCall({
      service: input.service,
      payload: input.payload,
      semanticType: input.semanticType,
    });
  }
  return { service: input.service, payload: { ...input.payload }, warnings: [], unsupported: [], fallback: null };
};

type SemanticCandidate = {
  entity_id: string;
  domain: string;
  area_name: string;
  device_name: string;
  friendly_name: string;
  score: number;
  score_breakdown: Record<string, number>;
};

type DeviceBrainCandidate = {
  entity_id: string;
  domain: string;
  area_name: string;
  device_name: string;
  friendly_name: string;
  score: number;
  score_breakdown: Record<string, number>;
  semantic_type: string;
  confidence: number;
  reasons: string[];
  non_actionable?: boolean;
  risk_level: "low" | "medium" | "high";
  recommended_primary: string;
  recommended_fallbacks: string[];
  capability_summary: Record<string, unknown>;
};

type DeviceBrainResult = {
  candidates: DeviceBrainCandidate[];
  best: DeviceBrainCandidate | null;
  needs_confirmation: boolean;
  requested_semantic: string | null;
};

const buildSemanticCandidates = (
  snapshot: {
    areas: RegistryArea[];
    devices: RegistryDevice[];
    entities: RegistryEntity[];
  },
  states: HaState[],
) => {
  const statesById = buildStatesById(states);
  const areasById = buildAreasById(snapshot.areas);
  const devicesById = buildDevicesById(snapshot.devices);

  return snapshot.entities.map((entity) => {
    const areaName = resolveAreaNameForEntity(entity, devicesById, areasById);
    const deviceName = resolveDeviceNameForEntity(entity, devicesById);
    const friendlyName = resolveFriendlyName(entity, statesById);
    const base = 10;
    const scoreBreakdown: Record<string, number> = {
      base,
      friendly_name: friendlyName ? 5 : 0,
      area_name: areaName ? 3 : 0,
      device_name: deviceName ? 2 : 0,
    };
    const score = Object.values(scoreBreakdown).reduce((sum, val) => sum + val, 0);
    return {
      entity_id: entity.entity_id,
      domain: entity.entity_id.split(".")[0] ?? "",
      area_name: areaName,
      device_name: deviceName,
      friendly_name: friendlyName,
      score,
      score_breakdown: scoreBreakdown,
    } satisfies SemanticCandidate;
  });
};

const scoreCandidateForQuery = (
  candidate: SemanticCandidate,
  query: string,
  areaHint?: string,
  domainHint?: string,
) => {
  const breakdown: Record<string, number> = { base: 10 };
  const normalizedQuery = normalizeName(query);
  const normalizedFriendly = normalizeName(candidate.friendly_name);
  const normalizedEntity = normalizeName(candidate.entity_id);
  const normalizedDevice = normalizeName(candidate.device_name);

  if (normalizedQuery && normalizedFriendly === normalizedQuery) {
    breakdown.friendly_exact = 60;
  } else if (normalizedQuery && normalizedFriendly.includes(normalizedQuery)) {
    breakdown.friendly_contains = 30;
  }

  if (normalizedQuery && normalizedEntity === normalizedQuery) {
    breakdown.entity_exact = 55;
  } else if (normalizedQuery && normalizedEntity.includes(normalizedQuery)) {
    breakdown.entity_contains = 25;
  }

  if (normalizedQuery && normalizedDevice.includes(normalizedQuery)) {
    breakdown.device_contains = 10;
  }

  if (areaHint && normalizeName(candidate.area_name) === normalizeName(areaHint)) {
    breakdown.area_match = 15;
  }

  if (domainHint && candidate.domain === domainHint) {
    breakdown.domain_match = 15;
  }

  const score = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
  return { score, score_breakdown: breakdown };
};

const buildDeviceBrainResult = async (input: {
  snapshot: Awaited<ReturnType<typeof fetchInventorySnapshot>>;
  target: { entity_id?: string; name?: string; area?: string; device_id?: string; domain?: string };
  intentProperty?: string;
  learnedStore: LearnedSemanticStore;
  semanticMap?: Record<string, SemanticResolution>;
}) => {
  const query = input.target.name ?? input.target.entity_id ?? "";
  const desiredSemantic = inferSemanticFromText(
    [input.target.name, input.target.domain, input.intentProperty].filter(Boolean).join(" "),
  );
  const normalizedQuery = normalizeName(query);
  const normalizedArea = normalizeName(input.target.area ?? "");
  const normalizedDomain = normalizeName(input.target.domain ?? "");
  const learnedMatch = input.target.name ? resolveLearnedAlias(input.target.name, input.learnedStore) : null;

  const overrides = await loadSemanticOverrides();
  const candidates: DeviceBrainCandidate[] = [];
  for (const entity of Object.values(input.snapshot.entities)) {
    if (input.target.entity_id && entity.entity_id !== input.target.entity_id) continue;
    if (input.target.device_id && entity.device_id !== input.target.device_id) continue;
    if (normalizedDomain && normalizeName(entity.domain) !== normalizedDomain) continue;
    if (normalizedArea && normalizeName(entity.area_name) !== normalizedArea) continue;

    const haystack = normalizeName(
      `${entity.entity_id} ${entity.friendly_name} ${entity.original_name} ${entity.device_name} ${entity.area_name}`,
    );
    let score = 10;
    const breakdown: Record<string, number> = { base: 10 };
    if (normalizedQuery) {
      if (normalizeName(entity.entity_id) === normalizedQuery) {
        score += 40;
        breakdown.entity_exact = 40;
      } else if (normalizeName(entity.friendly_name) === normalizedQuery) {
        score += 40;
        breakdown.friendly_exact = 40;
      } else if (haystack.includes(normalizedQuery)) {
        score += 20;
        breakdown.query_match = 20;
      }
      const aliasMatch = entity.aliases?.some((alias) => normalizeName(alias) === normalizedQuery);
      if (aliasMatch) {
        score += 25;
        breakdown.alias_exact = 25;
      }
    }
    if (learnedMatch?.entity_id === entity.entity_id) {
      score += 30;
      breakdown.learned_alias = 30;
    }
    if (desiredSemantic && input.semanticMap?.[entity.entity_id]?.semantic_type === desiredSemantic) {
      score += 15;
      breakdown.semantic_match = 15;
    }
    if (normalizedDomain && normalizeName(entity.domain) === normalizedDomain) {
      score += 10;
      breakdown.domain_match = 10;
    }
    if (normalizedArea && normalizeName(entity.area_name) === normalizedArea) {
      score += 10;
      breakdown.area_match = 10;
    }

    const resolution =
      input.semanticMap?.[entity.entity_id] ??
      buildSemanticResolution({
        entity,
        deviceEntities: Object.values(input.snapshot.entities).filter(
          (entry) => entry.device_id && entry.device_id === entity.device_id,
        ),
        overrides,
        learnedStore: input.learnedStore,
        servicesByDomain: input.snapshot.services_by_domain ?? {},
        deviceGraph: input.snapshot.device_graph ?? {},
      });
    if (resolution.non_actionable) {
      score -= 15;
      breakdown.non_actionable = -15;
    }

    const state: HaState = {
      entity_id: entity.entity_id,
      state: entity.state ?? "",
      attributes: entity.attributes ?? {},
    };

    candidates.push({
      entity_id: entity.entity_id,
      domain: entity.domain,
      area_name: entity.area_name,
      device_name: entity.device_name,
      friendly_name: entity.friendly_name,
      score,
      score_breakdown: breakdown,
      semantic_type: resolution.semantic_type,
      confidence: resolution.confidence,
      reasons: resolution.reasons,
      non_actionable: resolution.non_actionable,
      risk_level: getRiskLevel(resolution.semantic_type, entity.domain),
      recommended_primary: resolution.recommended_primary,
      recommended_fallbacks: resolution.recommended_fallbacks,
      capability_summary: describeCapability(entity.entity_id, state),
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.confidence - a.confidence;
  });
  const best = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const scoreGap = best && second ? best.score - second.score : best?.score ?? 0;
  const needs_confirmation = !best || best.score < 20 || (second && best.score < 40 && scoreGap < 10);

  return {
    candidates,
    best,
    needs_confirmation,
    requested_semantic: desiredSemantic || null,
  } satisfies DeviceBrainResult;
};

const resolveConfigDir = async () => {
  const dir = safeString(process.env.HA_CONFIG_DIR);
  if (!dir) return null;
  const resolved = resolve(dir);
  const stats = await stat(resolved).catch(() => null);
  if (!stats || !stats.isDirectory()) return null;
  return resolved;
};

const loadYamlModule = async () => {
  try {
    const mod = await import("yaml");
    return mod as { parse: (input: string) => unknown; stringify: (input: unknown) => string };
  } catch {
    return null;
  }
};

const readYamlFile = async (filePath: string) => {
  const mod = await loadYamlModule();
  if (!mod) {
    throw new Error("YAML parser unavailable");
  }
  const text = await readFile(filePath, "utf8");
  return mod.parse(text);
};

const listConfigFiles = async (configDir: string) => {
  const entries = await readdir(configDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
};

const ensureWithinDir = (baseDir: string, filePath: string) => {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(`${baseDir}/`)) {
    throw new Error("Path must stay within HA_CONFIG_DIR");
  }
  return resolved;
};

const snapshotConfigFile = async (filePath: string) => {
  const snapshotDir = join(
    process.env.HOME ?? "/home/node",
    ".openclaw",
    "logs",
    "ha-config-snapshots",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(snapshotDir, { recursive: true });
  const target = join(snapshotDir, basename(filePath));
  await copyFile(filePath, target);
  return target;
};

const applyConfigPatch = async (params: {
  file: string;
  before: string;
  after: string;
  validate?: boolean;
  reload_domain?: string;
}) => {
  const configDir = await resolveConfigDir();
  if (!configDir) {
    throw new Error("HA_CONFIG_DIR not set or not accessible");
  }
  const targetPath = ensureWithinDir(configDir, join(configDir, params.file));
  const original = await readFile(targetPath, "utf8");
  if (!original.includes(params.before)) {
    throw new Error("Patch 'before' text not found");
  }
  const snapshot = await snapshotConfigFile(targetPath);
  const updated = original.replace(params.before, params.after);
  await writeFile(targetPath, updated, "utf8");

  const shouldValidate = params.validate !== false;
  if (shouldValidate) {
    const validation = await wsCall("config/core/check_config");
    if (!validation.success) {
      await copyFile(snapshot, targetPath);
      throw new Error("HA config validation failed; rollback applied");
    }
  }

  if (params.reload_domain) {
    const baseUrl = getHaBaseUrl();
    const token = getHaToken();
    await requestJson({
      method: "POST",
      url: `${baseUrl}/api/services/${encodeURIComponent(params.reload_domain)}/reload`,
      token,
      body: {},
    });
  }

  return { snapshot };
};

type ConfigItem = {
  kind: "automation" | "script" | "helper";
  id: string;
  alias: string;
  entity_id: string;
  file: string;
  trigger?: unknown;
};

const matchQuery = (item: ConfigItem, query?: string) => {
  if (!query) return true;
  const haystack = [
    item.id,
    item.alias,
    item.entity_id,
    item.file,
    JSON.stringify(item.trigger ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
};

const loadConfigItems = async (configDir: string, query?: string, kinds?: string[]) => {
  const requestedKinds = new Set((kinds ?? []).map((kind) => kind.toLowerCase()));
  const shouldInclude = (kind: string) =>
    requestedKinds.size === 0 || requestedKinds.has(kind.toLowerCase());
  const files = await listConfigFiles(configDir);
  const items: ConfigItem[] = [];

  const maybeLoad = async (fileName: string) => {
    if (!files.includes(fileName)) return null;
    const fullPath = join(configDir, fileName);
    const data = await readYamlFile(fullPath);
    return { data, file: fileName };
  };

  if (shouldInclude("automation")) {
    const res = await maybeLoad("automations.yaml");
    if (res && Array.isArray(res.data)) {
      for (const entry of res.data as Array<Record<string, unknown>>) {
        const id = safeString(entry["id"]);
        const alias = safeString(entry["alias"]);
        items.push({
          kind: "automation",
          id,
          alias,
          entity_id: id ? `automation.${id}` : "",
          file: res.file,
          trigger: entry["trigger"],
        });
      }
    }
  }

  if (shouldInclude("script")) {
    const res = await maybeLoad("scripts.yaml");
    if (res && res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
      for (const [id, entry] of Object.entries(res.data as Record<string, Record<string, unknown>>)) {
        items.push({
          kind: "script",
          id,
          alias: safeString(entry["alias"]) || id,
          entity_id: `script.${id}`,
          file: res.file,
          trigger: entry["sequence"],
        });
      }
    }
  }

  if (shouldInclude("helper")) {
    const helperFiles = [
      "input_boolean.yaml",
      "input_number.yaml",
      "input_text.yaml",
      "input_select.yaml",
      "input_datetime.yaml",
      "input_button.yaml",
    ];
    for (const helperFile of helperFiles) {
      const res = await maybeLoad(helperFile);
      if (res && res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
        for (const [id, entry] of Object.entries(res.data as Record<string, Record<string, unknown>>)) {
          items.push({
            kind: "helper",
            id,
            alias: safeString(entry["name"]) || id,
            entity_id: `${helperFile.replace(".yaml", "")}.${id}`,
            file: res.file,
          });
        }
      }
    }
  }

  return items.filter((item) => matchQuery(item, query));
};

const registerTools = (api: OpenClawPluginApi) => {
  const registerTool = (
    tool: Parameters<typeof api.registerTool>[0],
    opts?: Parameters<typeof api.registerTool>[1],
  ) =>
    api.registerTool((ctx) => {
      const resolved = typeof tool === "function" ? (tool as never)(ctx) : tool;
      if (!resolved) return resolved;
      if (Array.isArray(resolved)) {
        return resolved.map((entry) => withToolContext(entry as never, ctx));
      }
      return withToolContext(resolved as never, ctx);
    }, opts);

  registerTool(
    {
      name: "ha_ping",
      description: "Ping Home Assistant (returns ok + version if reachable).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/config`,
            token,
          });

          await traceToolCall({
            tool: "ha_ping",
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/config",
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(`HA ping failed: ${res.status}`);
          }

          const version = (res.data as { version?: string })?.version ?? "unknown";
          return textResult(`ok (version=${version})`);
        } catch (err) {
          await traceToolCall({
            tool: "ha_ping",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/config",
            error: err,
          });
          return textResult(`HA ping error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_time_probe",
      description: "Return HA/host time context for debugging time windows.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const haTimeZone = await getHaTimeZone();
          const hostNow = new Date();
          const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
          const response = {
            ha_time_zone: haTimeZone,
            now_utc: hostNow.toISOString(),
            now_local: formatLocalTimeSafe(hostNow, haTimeZone),
            host_utc: hostNow.toISOString(),
            host_local: formatLocalTimeSafe(hostNow, hostTimeZone),
            host_time_zone: hostTimeZone,
            skew_seconds_estimate: 0,
            skew_source: "host_clock_only",
          };

          await traceToolCall({
            tool: "ha_time_probe",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "time_probe",
            resultBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
          });

          return textResult(JSON.stringify(response, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_time_probe",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "time_probe",
            error: err,
          });
          return textResult(`HA time_probe error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_time_truth",
      description: "Return HA + host time truth (timezone, now, and skew).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const haTimeZone = await getHaTimeZone();
          const hostNow = new Date();
          const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

          let haNow: Date | null = null;
          let haNowSource: "ha_template" | "host_fallback" = "host_fallback";
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestText({
              method: "POST",
              url: `${baseUrl}/api/template`,
              token,
              body: { template: "{{ now().timestamp() }}" },
              timeoutMs: DEFAULT_TIMEOUT_MS,
            });
            const parsed = Number(res.text.trim());
            if (res.ok && Number.isFinite(parsed)) {
              haNow = new Date(parsed * 1000);
              haNowSource = "ha_template";
            }
          } catch {
            haNow = null;
          }

          const haNowResolved = haNow ?? hostNow;
          const skewSeconds = Math.round((haNowResolved.getTime() - hostNow.getTime()) / 1000);
          const sourceNote =
            haNowSource === "ha_template" ? "HA vrijeme iz /api/template." : "HA vrijeme nije dostupno; koristi se host vrijeme.";
          const response = {
            ha_timezone: haTimeZone,
            ha_now_utc: haNowResolved.toISOString(),
            ha_now_local: formatLocalTimeSafe(haNowResolved, haTimeZone),
            host_now_utc: hostNow.toISOString(),
            host_now_local: formatLocalTimeSafe(hostNow, hostTimeZone),
            host_time_zone: hostTimeZone,
            skew_seconds: skewSeconds,
            ha_now_source: haNowSource,
            assistant_reply:
              `HA: ${formatLocalTimeSafe(haNowResolved, haTimeZone)} (${haTimeZone}). ` +
              `Host: ${formatLocalTimeSafe(hostNow, hostTimeZone)} (${hostTimeZone}). ` +
              `Odstupanje: ${skewSeconds}s. ${sourceNote}`,
            assistant_reply_short:
              `HA: ${formatLocalTimeSafe(haNowResolved, haTimeZone)} (${haTimeZone}). ` +
              `Host: ${formatLocalTimeSafe(hostNow, hostTimeZone)} (${hostTimeZone}). ` +
              `Odstupanje: ${skewSeconds}s. ${sourceNote}`,
          };

          await traceToolCall({
            tool: "ha_time_truth",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "time_truth",
            resultBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
          });

          return textResult(JSON.stringify(response, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_time_truth",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "time_truth",
            error: err,
          });
          return textResult(`HA time_truth error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_ws_call",
      description: "Call a Home Assistant WebSocket API type (allowlisted).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          payload: { type: "object", additionalProperties: true },
        },
        required: ["type"],
      },
      async execute(_id: string, params: { type: string; payload?: Record<string, unknown> }) {
        const started = Date.now();
        try {
          const res = await wsCall(params.type, params.payload ?? {});
          await traceToolCall({
            tool: "ha_ws_call",
            params,
            durationMs: Date.now() - started,
            ok: res.success,
            endpoint: params.type,
            resultBytes: res.bytes,
          });
          if (!res.success) {
            return textResult(`HA ws_call error: ${JSON.stringify(res.error ?? "")}`);
          }
          return textResult(JSON.stringify(res.result ?? null, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_ws_call",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: params.type,
            error: err,
          });
          return textResult(`HA ws_call error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_call_service",
      description: "Call a Home Assistant service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string" },
          service: { type: "string" },
          target: { type: "object", additionalProperties: true },
          data: { type: "object", additionalProperties: true },
          service_data: { type: "object", additionalProperties: true },
          entity_id: { type: "array", items: { type: "string" } },
          force_confirm: { type: "boolean" },
        },
        required: ["domain", "service"],
      },
      async execute(
        _id: string,
        params: {
          domain: string;
          service: string;
          target?: Record<string, unknown>;
          data?: Record<string, unknown>;
          service_data?: Record<string, unknown>;
          entity_id?: string[];
          force_confirm?: boolean;
        },
      ) {
        const started = Date.now();
        let semanticAssessment: { by_entity: Record<string, SemanticResult>; requires_confirm: boolean; hints: string[] } | null =
          null;
        try {
          const basePayload = buildServicePayload(params.target, params.data);
          if (params.service_data) {
            Object.assign(basePayload, params.service_data);
          }
          if (params.entity_id) {
            basePayload.entity_id = params.entity_id;
          }
          const baseEntityIds = toArray(basePayload.entity_id as string | string[] | undefined).filter(Boolean);
          semanticAssessment = baseEntityIds.length > 0 ? await buildSemanticAssessment(baseEntityIds) : null;
          const primarySemanticType = baseEntityIds[0]
            ? semanticAssessment?.by_entity?.[baseEntityIds[0]]?.semantic_type
            : undefined;
          const normalized = await normalizeFriendlyServiceCall({
            domain: params.domain,
            service: params.service,
            payload: basePayload,
            entityIds: baseEntityIds,
            semanticType: primarySemanticType,
          });
          const service = normalized.service;
          const payload = normalized.payload;
          const normalizationWarnings = normalized.warnings ?? [];
          const normalizationUnsupported = normalized.unsupported ?? [];
          const normalizationFallback = normalized.fallback ?? null;
          const entityIds = toArray(payload.entity_id as string | string[] | undefined).filter(Boolean);
          const decision = getPolicyDecision({
            domain: params.domain,
            service,
            entityIds,
          });
          const actionKind = `${params.domain}.${service}`;
          const approvalsOk =
            entityIds.length > 0
              ? (await Promise.all(entityIds.map((entityId) => hasRiskApproval(entityId, actionKind)))).every(Boolean)
              : false;
          const semanticConfirmRequired = Boolean(semanticAssessment?.requires_confirm);
          if (decision.action === "deny") {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  error: "denied",
                  reason: decision.reason,
                  verification: buildEmptyVerification("denied", entityIds),
                  semantic: semanticAssessment?.by_entity ?? null,
                  assistant_reply: `Odbijeno: ${decision.reason}.`,
                  assistant_reply_short: `Odbijeno: ${decision.reason}.`,
                },
                null,
                2,
              ),
            );
          }
          if (
            !approvalsOk &&
            (params.force_confirm || decision.action === "confirm_required" || semanticConfirmRequired)
          ) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  error: "confirm_required",
                  reason: params.force_confirm ? "force_confirm" : semanticConfirmRequired ? "semantic_low_confidence" : decision.reason,
                  verification: buildEmptyVerification("confirm_required", entityIds),
                  semantic: semanticAssessment?.by_entity ?? null,
                  semantic_hints: semanticAssessment?.hints ?? [],
                  assistant_reply:
                    "Potrebna je potvrda. Koristi ha_prepare_risky_action + ha_confirm_action.",
                  assistant_reply_short:
                    "Potrebna je potvrda. Koristi ha_prepare_risky_action + ha_confirm_action.",
                },
                null,
                2,
              ),
            );
          }
          if (READONLY_DOMAINS.has(params.domain)) {
            if (entityIds.length === 0) {
              return textResult(
                JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  error: "read_only",
                  reason: "missing_entity",
                  verification: buildEmptyVerification("read_only", entityIds),
                  semantic: semanticAssessment?.by_entity ?? null,
                  semantic_hints: semanticAssessment?.hints ?? [],
                  assistant_reply: "Ovaj domen je samo za čitanje. Treba entity_id za status.",
                  assistant_reply_short: "Domen je samo za čitanje.",
                },
                null,
                2,
                ),
              );
            }
            const states = await Promise.all(entityIds.map((entityId) => fetchEntityState(entityId)));
            const evidence = buildEntityEvidenceMap(entityIds, states);
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  error: "read_only",
                  verification: {
                    attempted: false,
                    ok: false,
                    level: "none",
                    method: "none",
                    reason: "read_only",
                    targets: entityIds,
                    before: evidence,
                    after: evidence,
                  },
                  semantic: semanticAssessment?.by_entity ?? null,
                  semantic_hints: semanticAssessment?.hints ?? [],
                  status: evidence,
                  assistant_reply: "Ovaj domen je samo za čitanje. Status je vraćen.",
                  assistant_reply_short: "Domen je samo za čitanje.",
                },
                null,
                2,
              ),
            );
          }
          if (entityIds.length > 0) {
            const snapshot = await buildRegistrySnapshot();
            const statesById = buildStatesById(snapshot.states);
            const missing = entityIds.filter((entityId) => !statesById.has(entityId));
            if (missing.length > 0) {
              const suggestions = snapshot.entities
                .filter((entity) => entity.entity_id.startsWith(`${params.domain}.`))
                .slice(0, 5)
                .map((entity) => ({
                  entity_id: entity.entity_id,
                  friendly_name: resolveFriendlyName(entity, statesById),
                }));
              return textResult(
                JSON.stringify(
                  {
                    ok: false,
                    service_ok: false,
                    service: `${params.domain}.${service}`,
                    error: "entity_not_found",
                    missing,
                    suggestions,
                    verification: buildEmptyVerification("entity_not_found", entityIds),
                    semantic: semanticAssessment?.by_entity ?? null,
                    semantic_hints: semanticAssessment?.hints ?? [],
                    assistant_reply: "Ne mogu naći traženi entitet.",
                    assistant_reply_short: "Ne mogu naći traženi entitet.",
                  },
                  null,
                  2,
                ),
              );
            }
          }
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const warnings: string[] = [];
          const deprecated_fields: string[] = [];
          const deprecated_notes: string[] = [];
          const unsupported_features: string[] = [];
          const unverifiable_features: string[] = [];
          warnings.push(...normalizationWarnings);
          unsupported_features.push(...normalizationUnsupported);
          let colorRequested = false;
          let expected: LightExpected | null = null;
          let capabilities: LightCapabilities | null = null;
          let physicalContext:
            | {
                area_name: string;
                sensors: Array<{ entity_id: string; type: string; unit: string }>;
                sensor_before: Record<string, number | null>;
              }
            | null = null;
          if (params.domain === "light" && service === "turn_on") {
            const servicesRes = await fetchServices();
            const fields = servicesRes.ok ? getServiceFields(servicesRes.data, "light", "turn_on") : {};
            const primaryEntity = entityIds[0];
            const state = primaryEntity ? await fetchEntityState(primaryEntity) : null;
            const request = extractLightRequest(payload);
            capabilities = buildLightCapabilities(state);
            const normalized = normalizeLightTurnOnPayload(payload, fields, capabilities, request);
            replacePayload(payload, normalized.normalized);
            warnings.push(...normalized.warnings);
            deprecated_fields.push(...normalized.deprecated);
            deprecated_notes.push(...normalized.deprecated_notes);
            unsupported_features.push(...normalized.unsupported);
            expected = normalized.expected;
            const colored = applyRequestedColor({
              payload,
              request,
              capabilities,
            });
            replacePayload(payload, colored.payload);
            delete payload.color;
            delete payload.color_name;
            warnings.push(...colored.warnings);
            unsupported_features.push(...colored.unsupported);
            unverifiable_features.push(...colored.unverifiable);
            colorRequested = colored.colorRequested;
            if (colored.expectedColor) {
              expected = { ...(expected ?? {}), color: colored.expectedColor, state: "on" };
            }
          }

          if (
            params.domain === "light" &&
            service === "turn_on" &&
            entityIds.length > 0
          ) {
            const validationErrors: string[] = [];
            const brightnessPct = toNumber(payload.brightness_pct);
            if (brightnessPct !== undefined && (brightnessPct < 0 || brightnessPct > 100)) {
              validationErrors.push("brightness_pct must be within 0-100");
            }
            const payloadMired = toNumber(payload.color_temp);
            const kelvin =
              toNumber(payload.color_temp_kelvin ?? payload.kelvin) ??
              (payloadMired ? Math.round(1000000 / payloadMired) : undefined);
            if (kelvin !== undefined) {
              const states = await Promise.all(
                entityIds.map((entityId) => fetchEntityState(entityId)),
              );
              states.forEach((state, index) => {
                const range = getKelvinRange(state);
                if (range && (kelvin < range.min || kelvin > range.max)) {
                  validationErrors.push(
                    `${entityIds[index]} color_temp_kelvin out of range (${range.min}-${range.max})`,
                  );
                }
              });
            }
            if (validationErrors.length > 0) {
              return textResult(
                JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  reason: "validation_failed",
                  errors: validationErrors,
                  verification: buildEmptyVerification("validation_failed", entityIds),
                  semantic: semanticAssessment?.by_entity ?? null,
                  semantic_hints: semanticAssessment?.hints ?? [],
                  assistant_reply: "Ne mogu poslati zahtjev: validacija nije prošla.",
                  assistant_reply_short: "Validacija nije prošla.",
                },
                null,
                2,
                ),
              );
            }
          }

          let stateBefore: Array<HaState | null> | null = null;
          if (
            params.domain === "light" &&
            (service === "turn_on" || service === "turn_off") &&
            entityIds.length > 0
          ) {
            stateBefore = await Promise.all(entityIds.map((entityId) => fetchEntityState(entityId)));
          }
          if (
            params.domain === "light" &&
            (service === "turn_on" || service === "turn_off") &&
            entityIds.length > 0 &&
            !capabilities
          ) {
            capabilities = buildLightCapabilities(stateBefore?.[0] ?? null);
          }
          if (
            params.domain === "light" &&
            (service === "turn_on" || service === "turn_off") &&
            entityIds.length > 0
          ) {
            const snapshot = await buildRegistrySnapshot();
            const area = findAreaForEntity(entityIds[0], snapshot);
            const sensors = area.area_name
              ? collectGroundTruthSensors(area.area_name, snapshot)
              : [];
            const statesById = buildStatesById(snapshot.states);
            const sensorBefore: Record<string, number | null> = {};
            for (const sensor of sensors) {
              sensorBefore[sensor.entity_id] = parseNumericState(statesById.get(sensor.entity_id)?.state);
            }
            physicalContext = {
              area_name: area.area_name,
              sensors,
              sensor_before: sensorBefore,
            };
          }

          let res: { ok: boolean; status?: number; data?: unknown; bytes: number };
          let trace: Record<string, unknown> | null = null;
          let wsEventEvidence: Record<string, unknown> | null = null;
          let wsEventReceived = false;
          if (params.domain === "persistent_notification" && service === "create") {
            const notificationId = safeString(payload["notification_id"]);
            const wsTrace = await wsTraceServiceCommand({
              entityIds: [],
              domain: params.domain,
              service,
              data: payload,
              durationMs: 5000,
            });
            trace = {
              events: wsTrace.events,
              call_event: wsTrace.call_event,
              trace_summary: { event_count: wsTrace.events.length },
            };
            res = {
              ok: wsTrace.ok,
              status: wsTrace.ok ? 200 : undefined,
              data: wsTrace.service_result,
              bytes: Buffer.byteLength(JSON.stringify(wsTrace.service_result ?? {}), "utf8"),
            };
            const matchingEvent = wsTrace.events.find((entry) => {
              const data = entry["data"] as Record<string, unknown>;
              const domain = safeString(data?.["domain"]);
              const service = safeString(data?.["service"]);
              if (domain !== "persistent_notification" || service !== "create") return false;
              if (!notificationId) return true;
              const serviceData = data?.["service_data"] as Record<string, unknown> | undefined;
              return safeString(serviceData?.["notification_id"]) === notificationId;
            });
            wsEventReceived = Boolean(matchingEvent);
            if (matchingEvent) {
              const data = (matchingEvent["data"] ?? {}) as Record<string, unknown>;
              const serviceData = (data["service_data"] ?? {}) as Record<string, unknown>;
              wsEventEvidence = {
                event_type: safeString(matchingEvent["event_type"]),
                time_fired: safeString(matchingEvent["time_fired"]),
                domain: safeString(data["domain"]),
                service: safeString(data["service"]),
                notification_id: safeString(serviceData["notification_id"]),
              };
            }
          } else if (params.domain === "light" && (service === "turn_on" || service === "turn_off") && entityIds.length > 0) {
            const wsTrace = await wsTraceServiceCommand({
              entityIds,
              domain: params.domain,
              service,
              data: payload,
              durationMs: 10000,
            });
            trace = {
              events: wsTrace.events,
              states_during: wsTrace.states_during,
              call_event: wsTrace.call_event,
              trace_summary: {
                event_count: wsTrace.events.length,
                state_event_count: wsTrace.states_during.length,
              },
            };
            res = {
              ok: wsTrace.ok,
              status: wsTrace.ok ? 200 : undefined,
              data: wsTrace.service_result,
              bytes: Buffer.byteLength(JSON.stringify(wsTrace.service_result ?? {}), "utf8"),
            };
          } else {
            const wsTrace = await wsTraceServiceCommand({
              entityIds,
              domain: params.domain,
              service,
              data: payload,
              durationMs: 8000,
            });
            trace = {
              events: wsTrace.events,
              states_during: wsTrace.states_during,
              call_event: wsTrace.call_event,
              trace_summary: {
                event_count: wsTrace.events.length,
                state_event_count: wsTrace.states_during.length,
              },
            };
            res = {
              ok: wsTrace.ok,
              status: wsTrace.ok ? 200 : undefined,
              data: wsTrace.service_result,
              bytes: Buffer.byteLength(JSON.stringify(wsTrace.service_result ?? {}), "utf8"),
            };
          }

          await traceToolCall({
            tool: "ha_call_service",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint:
              params.domain === "light" && (service === "turn_on" || service === "turn_off")
                ? `ws:call_service:${params.domain}.${service}`
                : `/api/services/${params.domain}/${service}`,
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  service_ok: false,
                  service: `${params.domain}.${service}`,
                  http_status: res.status,
                  warnings,
                  verification: buildEmptyVerification("service_failed", entityIds),
                  semantic: semanticAssessment?.by_entity ?? null,
                  semantic_hints: semanticAssessment?.hints ?? [],
                  service_response: res.data ?? null,
                  assistant_reply: "HA servis nije uspio.",
                  assistant_reply_short: "HA servis nije uspio.",
                },
                null,
                2,
              ),
            );
          }

          let verification: VerificationResult = {
            attempted: false,
            ok: false,
            method: "none",
            reason: "not_verifiable",
            targets: entityIds,
            before: null,
            after: null,
          };
          let physicalEvidence: Record<string, unknown> | null = null;
          let overrideEvidence: Array<Record<string, unknown>> = [];
          let haStateOk = true;
          let finalOk = false;
          let assistantReply = "";
          let assistantReplyShort = "";
          if (
            params.domain === "light" &&
            (service === "turn_on" || service === "turn_off") &&
            entityIds.length > 0
          ) {
            const expectedState: LightExpected = {
              ...(expected ?? {}),
              state: service === "turn_on" ? "on" : "off",
            };
            await waitMs(1000);
            const states1 = await Promise.all(entityIds.map((entityId) => fetchEntityState(entityId)));
            await waitMs(4000);
            const states5 = await Promise.all(entityIds.map((entityId) => fetchEntityState(entityId)));
            if (!capabilities) {
              capabilities = buildLightCapabilities(states5[0] ?? states1[0] ?? null);
            }
            const stateAfter1s = buildLightEvidenceMap(entityIds, states1);
            const stateAfter5s = buildLightEvidenceMap(entityIds, states5);
            const stateBeforeEvidence = buildLightEvidenceMap(entityIds, stateBefore ?? []);
            const mismatches: string[] = [];
            entityIds.forEach((entityId, index) => {
              const observed = stateAfter5s[entityId];
              const caps = buildLightCapabilities(states5[index] ?? states1[index] ?? null);
              mismatches.push(
                ...buildLightMismatches({
                  entity_id: entityId,
                  expected: expectedState,
                  observed,
                  capabilities: caps,
                  unsupported: unsupported_features,
                }),
              );
              if (colorRequested && !expectedState.color) {
                if (unsupported_features.includes("color")) {
                  mismatches.push(`${entityId}:color_unsupported`);
                }
                if (unverifiable_features.includes("color")) {
                  mismatches.push(`${entityId}:color_unverifiable`);
                }
              }
            });
            haStateOk = mismatches.length === 0;

            const traceEvents = Array.isArray(trace?.events) ? (trace?.events as Record<string, unknown>[]) : [];
            const callEvent =
              (trace && "call_event" in trace ? (trace.call_event as Record<string, unknown> | null) : null) ??
              traceEvents.find((entry) => safeString(entry["event_type"]) === "call_service");
            const callTime =
              parseDateValue(safeString(callEvent?.["time_fired"])) ?? new Date(started);
            const overrideWindowSec = 90;
            const overrideStart = new Date(Date.now() - overrideWindowSec * 1000).toISOString();
            const overrideQuery = new URLSearchParams({
              end_time: new Date().toISOString(),
              entity: entityIds[0] ?? "",
            });
            const overrideLogbook = await requestJson({
              method: "GET",
              url: `${baseUrl}/api/logbook/${encodeURIComponent(overrideStart)}?${overrideQuery.toString()}`,
              token,
            });
            if (overrideLogbook.ok && Array.isArray(overrideLogbook.data)) {
              const entries = overrideLogbook.data as Record<string, unknown>[];
              const callTimeMs = callTime.getTime();
              overrideEvidence = entries
                .map((entry) => {
                  const when = parseDateValue(safeString(entry["when"]));
                  return {
                    when,
                    entry,
                  };
                })
                .filter((entry) => entry.when && entry.when.getTime() > callTimeMs + 1000)
                .map((entry) => entry.entry)
                .filter((entry) => {
                  const domain = safeString(entry["domain"]);
                  return ["automation", "scene", "script", "light"].includes(domain);
                })
                .slice(-5);
            }

            const overrideDetected = overrideEvidence.length > 0;
            finalOk = haStateOk && !overrideDetected;

            verification = {
              attempted: true,
              ok: haStateOk,
              level: haStateOk ? "state" : callEvent ? "ha_event" : "none",
              method: "state_poll",
              reason: haStateOk
                ? "verified"
                : unsupported_features.length > 0
                  ? "unsupported"
                  : mismatches.length > 0
                    ? "mismatch"
                    : "unverified",
              targets: entityIds,
              before: stateBeforeEvidence,
              after: stateAfter5s,
              evidence: {
                ws_call_service: callEvent ?? null,
                ws_state_events: trace?.states_during ?? [],
                applied_fallbacks: buildAppliedFallbacks(warnings, normalizationFallback),
              },
              expected: expectedState,
              observed_1s: stateAfter1s,
              observed_5s: stateAfter5s,
              state_after_1s: stateAfter1s,
              state_after_5s: stateAfter5s,
              mismatches,
              state_before: stateBeforeEvidence,
            };

            if (physicalContext) {
              const sensorAfter: Record<string, number | null> = {};
              for (const sensor of physicalContext.sensors) {
                const state = await fetchEntityState(sensor.entity_id);
                sensorAfter[sensor.entity_id] = parseNumericState(state?.state);
              }
              const lookbackSec = 60;
              const historyStart = new Date(Date.now() - lookbackSec * 1000).toISOString();
              const historyEnd = new Date().toISOString();
              const historyRes = await fetchHistoryPeriod(
                physicalContext.sensors.map((sensor) => sensor.entity_id),
                historyStart,
                historyEnd,
              );
              const historyBuckets = Array.isArray(historyRes.data)
                ? (historyRes.data as Array<Record<string, unknown>[]>)
                : [];
              const deltas = physicalContext.sensors.map((sensor, index) => {
                const before = physicalContext?.sensor_before[sensor.entity_id] ?? null;
                const after = sensorAfter[sensor.entity_id] ?? null;
                let historyDelta: number | null = null;
                const bucket = historyBuckets[index] ?? [];
                const numericStates = bucket
                  .map((entry) => parseNumericState(entry["state"]))
                  .filter((value): value is number => value !== null);
                if (numericStates.length >= 2) {
                  historyDelta = numericStates[numericStates.length - 1] - numericStates[0];
                }
                return {
                  entity_id: sensor.entity_id,
                  type: sensor.type,
                  unit: sensor.unit,
                  before,
                  after,
                  delta: before !== null && after !== null ? after - before : null,
                  history_delta: historyDelta,
                };
              });
              const thresholdByType: Record<string, number> = {
                illuminance: 3,
                power: 1,
                energy: 0.01,
              };
              const hasEvidence = deltas.some((entry) => {
                const threshold = thresholdByType[entry.type] ?? 0;
                const delta = Math.abs(entry.delta ?? 0);
                const historyDelta = Math.abs(entry.history_delta ?? 0);
                return delta >= threshold || historyDelta >= threshold;
              });
              physicalEvidence = {
                ok: hasEvidence,
                reason: hasEvidence ? null : "no_detectable_change",
                area_name: physicalContext.area_name,
                sensors_used: physicalContext.sensors,
                sensors_missing:
                  physicalContext.sensors.length === 0 ? ["illuminance", "power", "energy"] : [],
                deltas,
                history_window_sec: lookbackSec,
              };
            } else {
              physicalEvidence = {
                ok: false,
                reason: "no_ground_truth_sensors",
                sensors_missing: ["illuminance", "power", "energy"],
              };
            }

            if (!haStateOk) {
              await traceToolCall({
                tool: "ha_call_service_verification",
                params: { entity_ids: entityIds, expected: expectedState, physical: physicalEvidence },
                durationMs: Date.now() - started,
                ok: false,
                endpoint: "verification_failed",
              });
            }

            const primaryEntity = entityIds[0];
            const observedPrimary = stateAfter5s[primaryEntity];
            const expectedLine = buildLightExpectedLine(primaryEntity, expectedState);
            const evidenceLine = buildLightEvidenceLine(primaryEntity, observedPrimary);
            const unsupportedText = unsupported_features.includes("color")
              ? "boju"
              : unsupported_features.includes("color_temp")
                ? "temperaturu boje"
                : unsupported_features.includes("brightness")
                  ? "svjetlinu"
                  : "";
            const hasColorProofGap = mismatches.some(
              (entry) => entry.includes("color_not_reported") || entry.includes("color_unverifiable"),
            );
            if (overrideDetected) {
              const overrideSummary = overrideEvidence
                .map((entry) => {
                  const when = safeString(entry["when"]);
                  const domain = safeString(entry["domain"]);
                  const name = safeString(entry["name"]);
                  const message = safeString(entry["message"]);
                  const contextUser = safeString(entry["context_user_id"]);
                  const contextId = safeString(entry["context_id"]);
                  return `override.when=${when}, override.domain=${domain}, override.name=${name}, override.message=${message}, override.context_user_id=${contextUser}, override.context_id=${contextId}`;
                })
                .join("; ");
              assistantReply = `Stanje je prepisano nakon naredbe. Dokaz: ${overrideSummary}. ${evidenceLine}`;
            } else if (haStateOk) {
              const fallbackNote = warnings.find((entry) => entry.startsWith("color_mode_fallback"))
                ? " (koristio sam podržani color_mode)"
                : "";
              assistantReply = `Potvrđeno${fallbackNote}. ${evidenceLine}`;
            } else if (unsupportedText) {
              assistantReply = `Ne podržava ${unsupportedText}. Nije postavljeno kako je traženo. ${expectedLine}. ${evidenceLine}`;
            } else if (hasColorProofGap) {
              assistantReply = `HA ne daje dokaz za boju. Nije postavljeno kako je traženo. ${expectedLine}. ${evidenceLine}`;
            } else {
              assistantReply = `Nije postavljeno kako je traženo. ${expectedLine}. ${evidenceLine}`;
            }
            assistantReplyShort = assistantReply;
          } else {
            if (params.domain === "persistent_notification" && service === "create") {
              verification = {
                attempted: true,
                ok: wsEventReceived,
                level: wsEventReceived ? "ha_event" : "none",
                method: "ws_event",
                reason: wsEventReceived ? "verified" : "timeout",
                targets: [],
                before: null,
                after: null,
                evidence: wsEventEvidence,
              };
            } else if (entityIds.length > 0) {
              if (params.domain === "media_player") {
                verification = await verifyMediaPlayerChange({ service, payload, entityIds });
              } else if (params.domain === "climate") {
                verification = await verifyClimateChange({ service, payload, entityIds });
              } else if (params.domain === "cover") {
                verification = await verifyCoverChange({ service, payload, entityIds });
              } else if (params.domain === "fan") {
                verification = await verifyFanChange({ service, payload, entityIds });
              } else {
                verification = await pollForStateVerification({
                  domain: params.domain,
                  service,
                  payload,
                  entityIds,
                  timeoutMs: 5000,
                  intervalMs: 400,
                });
              }
            }

            finalOk = verification.ok;
            if (verification.ok) {
              if (normalizationFallback) {
                assistantReply = `Primijenjen je fallback (${normalizationFallback.reason}). Poslano, ali nije potvrđeno kao originalni zahtjev.`;
              } else {
                assistantReply = "Potvrđeno.";
              }
            } else if (verification.attempted) {
              assistantReply = `Poslao sam komandu, ali nemam potvrdu (${verification.reason}).`;
            } else {
              assistantReply = "Poslao sam komandu, ali ovaj alat nema provjeru za ovaj zahtjev.";
            }
            assistantReplyShort = assistantReply;

            if (verification.attempted) {
              const callEvent =
                trace && "call_event" in trace
                  ? (trace.call_event as Record<string, unknown> | null)
                  : null;
              verification = {
                ...verification,
                level: verification.ok ? "state" : callEvent ? "ha_event" : "none",
                evidence: {
                  ...(verification.evidence ?? {}),
                  ws_call_service: callEvent ?? null,
                  ws_state_events: trace?.states_during ?? [],
                  applied_fallbacks: buildAppliedFallbacks(warnings, normalizationFallback),
                },
              };
            }
          }

          if (normalizationFallback && verification.attempted) {
            verification = {
              ...verification,
              ok: false,
              reason: "fallback_applied",
              level: verification.level ?? "none",
              evidence: { ...(verification.evidence ?? {}), fallback: normalizationFallback },
            };
            finalOk = false;
          }

          return textResult(
            JSON.stringify(
              {
                ok: finalOk,
                service_ok: true,
                service: `${params.domain}.${service}`,
                warnings,
                deprecated_fields,
                deprecated_notes,
                capabilities: capabilities ?? null,
                override: { detected: overrideEvidence.length > 0, evidence: overrideEvidence },
                verification,
                fallback: normalizationFallback,
                semantic: semanticAssessment?.by_entity ?? null,
                semantic_hints: semanticAssessment?.hints ?? [],
                assistant_reply: assistantReply,
                assistant_reply_short: assistantReplyShort,
                ws_trace: trace,
                physical_evidence: physicalEvidence,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_call_service",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/services/${params.domain}/${params.service}`,
            error: err,
          });
          return textResult(
            JSON.stringify(
              {
                ok: false,
                service_ok: false,
                service: `${params.domain}.${params.service}`,
                error: sanitizeError(err) ?? String(err),
                verification: buildEmptyVerification("exception"),
                semantic: semanticAssessment?.by_entity ?? null,
                semantic_hints: semanticAssessment?.hints ?? [],
                assistant_reply: "HA servis nije uspio.",
                assistant_reply_short: "HA servis nije uspio.",
              },
              null,
              2,
            ),
          );
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_dry_run_service_call",
      description: "Validate a Home Assistant service call without executing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string" },
          service: { type: "string" },
          data: { type: "object", additionalProperties: true },
          target: { type: "object", additionalProperties: true },
          entity_id: { type: "array", items: { type: "string" } },
        },
        required: ["domain", "service"],
      },
      async execute(
        _id: string,
        params: {
          domain: string;
          service: string;
          data?: Record<string, unknown>;
          target?: Record<string, unknown>;
          entity_id?: string[];
        },
      ) {
        const started = Date.now();
        try {
          const servicesRes = await fetchServices();
          if (!servicesRes.ok) {
            return textResult("HA dry_run error: get_services failed");
          }
          const statesRes = await fetchStates();
          if (!statesRes.ok || !Array.isArray(statesRes.data)) {
            return textResult("HA dry_run error: /api/states failed");
          }
          const statesById = buildStatesById(statesRes.data as HaState[]);
          const warnings: string[] = [];
          const errors: string[] = [];
          const services = servicesRes.data as HaServices;
          const serviceDef = services[params.domain]?.[params.service];
          if (!serviceDef) {
            errors.push(`Unknown service ${params.domain}.${params.service}`);
          }

          const entityIds = [
            ...toArray(params.entity_id),
            ...toArray((params.target?.entity_id as string | string[] | undefined) ?? []),
          ].filter(Boolean);

          if (entityIds.length === 0 && !params.target) {
            warnings.push("No entity_id or target provided");
          }

          const fields = serviceDef?.fields ?? {};
          for (const [field, def] of Object.entries(fields)) {
            if (def?.required) {
              const hasValue =
                (params.data && field in params.data) ||
                (params.target && field in params.target) ||
                (field === "entity_id" && entityIds.length > 0);
              if (!hasValue) {
                errors.push(`Missing required field: ${field}`);
              }
            }
          }

          for (const entityId of entityIds) {
            const state = statesById.get(entityId);
            if (!state) {
              errors.push(`Unknown entity_id: ${entityId}`);
              continue;
            }
            const domain = entityId.split(".")[0] ?? "";
            if (domain !== params.domain) {
              errors.push(`Domain mismatch: ${entityId} is ${domain}, not ${params.domain}`);
            }
            const capabilities = describeCapability(entityId, state);
            if (params.domain === "light" && params.data) {
              if ("brightness" in params.data && !capabilities.derived_capabilities.includes("brightness")) {
                warnings.push(`brightness not supported by ${entityId}`);
              }
              if ("color_temp" in params.data && !capabilities.derived_capabilities.includes("color_temp")) {
                warnings.push(`color_temp not supported by ${entityId}`);
              }
              if ("rgb_color" in params.data && !capabilities.derived_capabilities.includes("color")) {
                warnings.push(`color not supported by ${entityId}`);
              }
            }
            if (params.domain === "climate" && params.data) {
              if ("temperature" in params.data && !capabilities.derived_capabilities.includes("temperature")) {
                warnings.push(`temperature not supported by ${entityId}`);
              }
            }
          }

          await traceToolCall({
            tool: "ha_dry_run_service_call",
            params,
            durationMs: Date.now() - started,
            ok: errors.length === 0,
            endpoint: `/api/services/${params.domain}/${params.service}`,
          });

          return textResult(
            JSON.stringify(
              {
                ok: errors.length === 0,
                warnings,
                errors,
                would_call: {
                  domain: params.domain,
                  service: params.service,
                  data: buildServicePayload(params.target, params.data),
                },
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_dry_run_service_call",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/services/${params.domain}/${params.service}`,
            error: err,
          });
          return textResult(`HA dry_run error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_get_state",
      description: "Get Home Assistant entity state by entity_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
        },
        required: ["entity_id"],
      },
      async execute(_id: string, params: { entity_id: string }) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/states/${encodeURIComponent(params.entity_id)}`,
            token,
          });

          await traceToolCall({
            tool: "ha_get_state",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: `/api/states/${params.entity_id}`,
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(`HA get_state error: ${res.status}`);
          }
          const tz = await getHaTimeZone();
          const now = new Date();
          return textResult(
            JSON.stringify(
              {
                tz,
                now_utc: now.toISOString(),
                now_local: formatLocalTimeSafe(now, tz),
                state: res.data,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_get_state",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/states/${params.entity_id}`,
            error: err,
          });
          return textResult(`HA get_state error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_trace_light_command",
      description: "Trace a light command via HA WebSocket events (state_changed + call_service).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          desired: { type: "object", additionalProperties: true },
          duration_sec: { type: "number" },
        },
        required: ["entity_id", "desired"],
      },
      async execute(
        _id: string,
        params: { entity_id: string; desired: Record<string, unknown>; duration_sec?: number },
      ) {
        const started = Date.now();
        try {
          const desiredState = String(params.desired["state"] ?? "on").toLowerCase();
          const service = desiredState === "off" ? "turn_off" : "turn_on";
          const data = { ...params.desired };
          delete data["state"];
          data["entity_id"] = params.entity_id;

          const stateBefore = await fetchEntityState(params.entity_id);
          const trace = await wsTraceServiceCommand({
            entityIds: [params.entity_id],
            domain: "light",
            service,
            data,
            durationMs: (params.duration_sec ?? 10) * 1000,
          });
          const stateAfter = await fetchEntityState(params.entity_id);

          await traceToolCall({
            tool: "ha_trace_light_command",
            params,
            durationMs: Date.now() - started,
            ok: trace.ok,
            endpoint: "ws:trace_light",
            resultBytes: Buffer.byteLength(JSON.stringify(trace), "utf8"),
          });

          const summary = {
            event_count: trace.events.length,
            state_event_count: trace.states_during.length,
            service_ok: trace.ok,
          };

          return textResult(
            JSON.stringify(
              {
                ok: trace.ok,
                desired: params.desired,
                state_before: stateBefore,
                states_during: trace.states_during,
                state_after: stateAfter,
                events: trace.events,
                trace_summary: summary,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_trace_light_command",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "ws:trace_light",
            error: err,
          });
          return textResult(`HA trace_light_command error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_light_identify",
      description: "Visually identify a light by blinking or strong color/temperature, then restore.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          seconds: { type: "number" },
        },
        required: ["entity_id"],
      },
      async execute(_id: string, params: { entity_id: string; seconds?: number }) {
        const started = Date.now();
        try {
          const before = await fetchEntityState(params.entity_id);
          const attrs = (before?.attributes ?? {}) as Record<string, unknown>;
          const effectList = Array.isArray(attrs["effect_list"]) ? (attrs["effect_list"] as string[]) : [];
          const supportedModes = Array.isArray(attrs["supported_color_modes"])
            ? (attrs["supported_color_modes"] as string[])
            : [];
          const hasXy = supportedModes.includes("xy");
          const hasColorTemp = supportedModes.includes("color_temp");
          const desired: Record<string, unknown> = { entity_id: params.entity_id, brightness_pct: 100 };
          if (effectList.includes("blink")) {
            desired.effect = "blink";
          } else if (hasXy) {
            desired.xy_color = [0.8, 0.3];
          } else if (hasColorTemp) {
            desired.color_temp_kelvin = toNumber(attrs["min_color_temp_kelvin"]) ?? 2000;
          }

          await requestJson({
            method: "POST",
            url: `${getHaBaseUrl()}/api/services/light/turn_on`,
            token: getHaToken(),
            body: desired,
          });

          await waitMs((params.seconds ?? 3) * 1000);

          if (before?.state === "off") {
            await requestJson({
              method: "POST",
              url: `${getHaBaseUrl()}/api/services/light/turn_off`,
              token: getHaToken(),
              body: { entity_id: params.entity_id },
            });
            await waitMs(1000);
          } else {
            const restore: Record<string, unknown> = { entity_id: params.entity_id };
            if (attrs["brightness"] !== undefined) restore.brightness = attrs["brightness"];
            if (attrs["color_temp_kelvin"] !== undefined) restore.color_temp_kelvin = attrs["color_temp_kelvin"];
            if (attrs["color_temp"] !== undefined) restore.color_temp = attrs["color_temp"];
            if (attrs["effect"] !== undefined && attrs["effect"] !== null) restore.effect = attrs["effect"];
            await requestJson({
              method: "POST",
              url: `${getHaBaseUrl()}/api/services/light/turn_on`,
              token: getHaToken(),
              body: restore,
            });
            await waitMs(1000);
          }

          let after = await fetchEntityState(params.entity_id);
          if (before?.state === "off" && after?.state !== "off") {
            await requestJson({
              method: "POST",
              url: `${getHaBaseUrl()}/api/services/light/turn_off`,
              token: getHaToken(),
              body: { entity_id: params.entity_id },
            });
            await waitMs(1000);
            after = await fetchEntityState(params.entity_id);
          }
          const restoreOk =
            before?.state === after?.state ||
            (before?.state === "off" && after?.state === "off") ||
            (before?.state === "on" && after?.state === "on");

          await traceToolCall({
            tool: "ha_light_identify",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "light_identify",
          });

          return textResult(
            JSON.stringify(
              {
                ok: true,
                entity_id: params.entity_id,
                identify_payload: desired,
                state_before: before,
                state_after: after,
                restore_ok: restoreOk,
                message: "DONE: identify executed",
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_light_identify",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "light_identify",
            error: err,
          });
          return textResult(`HA light_identify error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_light_physical_verify",
      description: "Verify a light change with ground-truth sensors (lux/power) when available.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          lookback_sec: { type: "number" },
        },
        required: ["entity_id"],
      },
      async execute(_id: string, params: { entity_id: string; lookback_sec?: number }) {
        const started = Date.now();
        try {
          const snapshot = await buildRegistrySnapshot();
          const area = findAreaForEntity(params.entity_id, snapshot);
          const sensors = area.area_name
            ? collectGroundTruthSensors(area.area_name, snapshot)
            : [];
          if (sensors.length === 0) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  reason: "no_ground_truth_sensors",
                  area_name: area.area_name,
                  sensors_missing: ["illuminance", "power", "energy"],
                },
                null,
                2,
              ),
            );
          }

          const statesById = buildStatesById(snapshot.states);
          const sensorBefore: Record<string, number | null> = {};
          for (const sensor of sensors) {
            sensorBefore[sensor.entity_id] = parseNumericState(statesById.get(sensor.entity_id)?.state);
          }

          const before = await fetchEntityState(params.entity_id);
          await requestJson({
            method: "POST",
            url: `${getHaBaseUrl()}/api/services/light/turn_on`,
            token: getHaToken(),
            body: { entity_id: params.entity_id, brightness_pct: 100, color_temp_kelvin: 2000 },
          });
          await waitMs(3000);

          const sensorAfter: Record<string, number | null> = {};
          for (const sensor of sensors) {
            const state = await fetchEntityState(sensor.entity_id);
            sensorAfter[sensor.entity_id] = parseNumericState(state?.state);
          }

          const lookback = params.lookback_sec ?? 60;
          const historyStart = new Date(Date.now() - lookback * 1000).toISOString();
          const historyEnd = new Date().toISOString();
          const historyRes = await fetchHistoryPeriod(
            sensors.map((sensor) => sensor.entity_id),
            historyStart,
            historyEnd,
          );
          const historyBuckets = Array.isArray(historyRes.data)
            ? (historyRes.data as Array<Record<string, unknown>[]>)
            : [];
          const deltas = sensors.map((sensor, index) => {
            const beforeValue = sensorBefore[sensor.entity_id] ?? null;
            const afterValue = sensorAfter[sensor.entity_id] ?? null;
            let historyDelta: number | null = null;
            const bucket = historyBuckets[index] ?? [];
            const numericStates = bucket
              .map((entry) => parseNumericState(entry["state"]))
              .filter((value): value is number => value !== null);
            if (numericStates.length >= 2) {
              historyDelta = numericStates[numericStates.length - 1] - numericStates[0];
            }
            return {
              entity_id: sensor.entity_id,
              type: sensor.type,
              unit: sensor.unit,
              before: beforeValue,
              after: afterValue,
              delta: beforeValue !== null && afterValue !== null ? afterValue - beforeValue : null,
              history_delta: historyDelta,
            };
          });
          const thresholdByType: Record<string, number> = {
            illuminance: 3,
            power: 1,
            energy: 0.01,
          };
          const ok = deltas.some((entry) => {
            const threshold = thresholdByType[entry.type] ?? 0;
            const delta = Math.abs(entry.delta ?? 0);
            const historyDelta = Math.abs(entry.history_delta ?? 0);
            return delta >= threshold || historyDelta >= threshold;
          });

          if (before?.state === "off") {
            await requestJson({
              method: "POST",
              url: `${getHaBaseUrl()}/api/services/light/turn_off`,
              token: getHaToken(),
              body: { entity_id: params.entity_id },
            });
          }

          await traceToolCall({
            tool: "ha_light_physical_verify",
            params,
            durationMs: Date.now() - started,
            ok,
            endpoint: "light_physical_verify",
          });

          return textResult(
            JSON.stringify(
              {
                ok,
                area_name: area.area_name,
                sensors_used: sensors,
                deltas,
                history_window_sec: lookback,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_light_physical_verify",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "light_physical_verify",
            error: err,
          });
          return textResult(`HA light_physical_verify error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_list_area_lights",
      description:
        "List lights in a specific area with compact, stable fields (no registry dump).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area_name: { type: "string" },
          limit: { type: "number" },
          fields: { type: "array", items: { type: "string" } },
        },
        required: ["area_name"],
      },
      async execute(
        _id: string,
        params: { area_name: string; limit?: number; fields?: string[] },
      ) {
        const started = Date.now();
        try {
          const snapshot = await buildRegistrySnapshot();
          const match = findAreaMatch(snapshot.areas, params.area_name);
          if (!match.area) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  error: "area_not_found",
                  area_name: params.area_name,
                  suggestions: match.suggestions,
                  assistant_reply: "Ne mogu naći traženo područje.",
                  assistant_reply_short: "Ne mogu naći traženo područje.",
                },
                null,
                2,
              ),
            );
          }

          const devicesById = buildDevicesById(snapshot.devices);
          const statesById = buildStatesById(snapshot.states);
          const areaId = match.area.area_id;
          const lights = snapshot.entities.filter((entity) => {
            if (!entity.entity_id.startsWith("light.")) return false;
            const resolvedAreaId = resolveAreaIdForEntity(entity, devicesById);
            return resolvedAreaId === areaId;
          });
          const rows = lights.map((entity) =>
            buildAreaLightRow({
              entity,
              state: statesById.get(entity.entity_id),
              friendly_name: resolveFriendlyName(entity, statesById),
            }),
          );
          const sorted = rows.sort((a, b) => {
            const aName = normalizeName(a.friendly_name || a.name || a.entity_id);
            const bName = normalizeName(b.friendly_name || b.name || b.entity_id);
            if (aName !== bName) return aName.localeCompare(bName);
            return a.entity_id.localeCompare(b.entity_id);
          });
          const limit = Math.max(1, Math.min(1000, Math.floor(params.limit ?? 200)));
          const fields = coerceLightListFields(params.fields);
          const sliced = sorted.slice(0, limit).map((row) => pickAreaLightFields(row, fields));

          await traceToolCall({
            tool: "ha_list_area_lights",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "registry_snapshot",
            resultBytes: Buffer.byteLength(JSON.stringify(sliced), "utf8"),
          });

          return textResult(
            JSON.stringify(
              {
                ok: true,
                area_name: match.area.name,
                area_id: match.area.area_id,
                total: sorted.length,
                returned: sliced.length,
                truncated: sorted.length > sliced.length,
                fields,
                lights: sliced,
                assistant_reply: `Pronađeno ${sorted.length} svjetala u području "${match.area.name}".`,
                assistant_reply_short: `Pronađeno ${sorted.length} svjetala u području "${match.area.name}".`,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_list_area_lights",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "registry_snapshot",
            error: err,
          });
          return textResult(`HA list_area_lights error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_room_lights_state",
      description: "List light states for a specific room/area (room-aware).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area_name: { type: "string" },
        },
        required: ["area_name"],
      },
      async execute(_id: string, params: { area_name: string }) {
        const started = Date.now();
        try {
          const snapshot = await buildRegistrySnapshot();
          const match = findAreaMatch(snapshot.areas, params.area_name);
          if (!match.area) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  reason: "unknown_area",
                  area_name: params.area_name,
                  suggestions: match.suggestions,
                },
                null,
                2,
              ),
            );
          }

          const areaEntry = snapshot.indexes.by_area_name[match.area.name];
          const statesById = buildStatesById(snapshot.states);
          const tz = await getHaTimeZone();
          const lights = (areaEntry?.entity_ids ?? [])
            .filter((entityId) => entityId.startsWith("light."))
            .map((entityId) => {
              const state = statesById.get(entityId);
              const lastChanged = parseDateValue(state?.last_changed);
              return {
                entity_id: entityId,
                friendly_name: safeString(state?.attributes?.["friendly_name"]),
                state: state?.state ?? "unknown",
                brightness: toNumber(state?.attributes?.["brightness"]),
                color_temp: toNumber(state?.attributes?.["color_temp"]),
                color_temp_kelvin: toNumber(state?.attributes?.["color_temp_kelvin"]),
                last_changed_utc: lastChanged?.toISOString() ?? null,
                last_changed_local: lastChanged ? formatLocalTimeSafe(lastChanged, tz) : null,
              };
            });

          await traceToolCall({
            tool: "ha_room_lights_state",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "room_lights_state",
            resultBytes: Buffer.byteLength(JSON.stringify(lights), "utf8"),
          });

          return textResult(
            JSON.stringify(
              {
                ok: true,
                area_name: match.area.name,
                count: lights.length,
                lights,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_room_lights_state",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "room_lights_state",
            error: err,
          });
          return textResult(`HA room_lights_state error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_last_on",
      description: "Return the last time an entity was turned on (history-based).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          lookback_minutes: { type: "number" },
        },
        required: ["entity_id"],
      },
      async execute(_id: string, params: { entity_id: string; lookback_minutes?: number }) {
        const started = Date.now();
        try {
          const lookback = params.lookback_minutes ?? 1440;
          const timeContext = await buildTimeContext({ minutes: lookback });
          const query = new URLSearchParams({
            end_time: timeContext.range_utc.end,
            filter_entity_id: params.entity_id,
            minimal_response: "1",
          });
          const res = await requestJson({
            method: "GET",
            url: `${getHaBaseUrl()}/api/history/period/${encodeURIComponent(
              timeContext.range_utc.start,
            )}?${query.toString()}`,
            token: getHaToken(),
          });

          await traceToolCall({
            tool: "ha_last_on",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/history/period",
            resultBytes: res.bytes,
          });

          if (!res.ok || !Array.isArray(res.data)) {
            return textResult(`HA last_on error: ${res.status}`);
          }
          const bucket = (res.data as Array<Record<string, unknown>[]>)[0] ?? [];
          let lastOn: Date | null = null;
          for (const entry of bucket) {
            const state = String(entry["state"] ?? "");
            if (state !== "on") continue;
            const when = parseDateValue(String(entry["last_changed"] ?? ""));
            if (!when) continue;
            if (!lastOn || when.getTime() > lastOn.getTime()) {
              lastOn = when;
            }
          }
          return textResult(
            JSON.stringify(
              {
                entity_id: params.entity_id,
                lookback_minutes: lookback,
                last_on_utc: lastOn ? lastOn.toISOString() : null,
                last_on_local: lastOn ? formatLocalTimeSafe(lastOn, timeContext.tz) : null,
                tz: timeContext.tz,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_last_on",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/history/period",
            error: err,
          });
          return textResult(`HA last_on error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_room_last_on",
      description: "Return last-on times for all lights in a room/area.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area_name: { type: "string" },
          lookback_minutes: { type: "number" },
        },
        required: ["area_name"],
      },
      async execute(_id: string, params: { area_name: string; lookback_minutes?: number }) {
        const started = Date.now();
        try {
          const snapshot = await buildRegistrySnapshot();
          const match = findAreaMatch(snapshot.areas, params.area_name);
          if (!match.area) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  reason: "unknown_area",
                  area_name: params.area_name,
                  suggestions: match.suggestions,
                },
                null,
                2,
              ),
            );
          }

          const areaEntry = snapshot.indexes.by_area_name[match.area.name];
          const lightIds = (areaEntry?.entity_ids ?? []).filter((entityId) =>
            entityId.startsWith("light."),
          );
          const lookback = params.lookback_minutes ?? 1440;
          const timeContext = await buildTimeContext({ minutes: lookback });
          const query = new URLSearchParams({
            end_time: timeContext.range_utc.end,
            filter_entity_id: lightIds.join(","),
            minimal_response: "1",
          });
          const res = await requestJson({
            method: "GET",
            url: `${getHaBaseUrl()}/api/history/period/${encodeURIComponent(
              timeContext.range_utc.start,
            )}?${query.toString()}`,
            token: getHaToken(),
          });

          await traceToolCall({
            tool: "ha_room_last_on",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/history/period",
            resultBytes: res.bytes,
          });

          if (!res.ok || !Array.isArray(res.data)) {
            return textResult(`HA room_last_on error: ${res.status}`);
          }

          const buckets = res.data as Array<Record<string, unknown>[]>;
          const results = lightIds.map((entityId, index) => {
            const bucket = buckets[index] ?? [];
            let lastOn: Date | null = null;
            for (const entry of bucket) {
              const state = String(entry["state"] ?? "");
              if (state !== "on") continue;
              const when = parseDateValue(String(entry["last_changed"] ?? ""));
              if (!when) continue;
              if (!lastOn || when.getTime() > lastOn.getTime()) {
                lastOn = when;
              }
            }
            return {
              entity_id: entityId,
              last_on_utc: lastOn ? lastOn.toISOString() : null,
              last_on_local: lastOn ? formatLocalTimeSafe(lastOn, timeContext.tz) : null,
            };
          });

          const sorted = results.sort((a, b) => {
            if (!a.last_on_utc && !b.last_on_utc) return 0;
            if (!a.last_on_utc) return 1;
            if (!b.last_on_utc) return -1;
            return b.last_on_utc.localeCompare(a.last_on_utc);
          });

          return textResult(
            JSON.stringify(
              {
                ok: true,
                area_name: match.area.name,
                lookback_minutes: lookback,
                tz: timeContext.tz,
                lights: sorted,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_room_last_on",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/history/period",
            error: err,
          });
          return textResult(`HA room_last_on error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_list_entities",
      description: "List Home Assistant entities (optionally filtered).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string" },
          contains: { type: "string" },
        },
      },
      async execute(_id: string, params: { domain?: string; contains?: string }) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/states`,
            token,
          });

          await traceToolCall({
            tool: "ha_list_entities",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/states",
            resultBytes: res.bytes,
          });

          if (!res.ok || !Array.isArray(res.data)) {
            return textResult(`HA list_entities error: ${res.status}`);
          }

          const filtered = listEntitiesFiltered(res.data as HaState[], params.domain, params.contains);
          return textResult(JSON.stringify(filtered, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_list_entities",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/states",
            error: err,
          });
          return textResult(`HA list_entities error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_inventory_snapshot",
      description: "Return a merged HA inventory snapshot (registry + states + services).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const snapshot = await fetchInventorySnapshot();
          await traceToolCall({
            tool: "ha_inventory_snapshot",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "inventory_snapshot",
            resultBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
          });
          return textResult(JSON.stringify(snapshot, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_inventory_snapshot",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "inventory_snapshot",
            error: err,
          });
          return textResult(`HA inventory_snapshot error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_list_semantic_overrides",
      description: "List semantic overrides for entity/device semantics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const overrides = await loadSemanticOverrides();
          await traceToolCall({
            tool: "ha_list_semantic_overrides",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "semantic_overrides",
            resultBytes: Buffer.byteLength(JSON.stringify(overrides), "utf8"),
          });
          return textResult(
            JSON.stringify(
              {
                schema: SEMANTIC_OVERRIDE_SCHEMA,
                path: SEMANTIC_OVERRIDES_PATH,
                overrides,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_list_semantic_overrides",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "semantic_overrides",
            error: err,
          });
          return textResult(`HA list_semantic_overrides error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_upsert_semantic_override",
      description: "Create or update a semantic override for entity/device semantics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string" },
          id: { type: "string" },
          semantic_type: { type: "string" },
          control_model: { type: "string" },
          smoke_test_safe: { type: "boolean" },
          notes: { type: "string" },
          force_confirm: { type: "boolean" },
        },
        required: ["scope", "id"],
      },
      async execute(
        _id: string,
        params: {
          scope: "entity" | "device";
          id: string;
          semantic_type?: string;
          control_model?: string;
          smoke_test_safe?: boolean;
          notes?: string;
          force_confirm?: boolean;
        },
      ) {
        const started = Date.now();
        try {
          const scope = params.scope;
          if (scope !== "entity" && scope !== "device") {
            return textResult("HA upsert_semantic_override error: scope must be entity or device");
          }
          const target = params.id.trim();
          if (!target) {
            return textResult("HA upsert_semantic_override error: id is required");
          }
          const risky =
            (params.semantic_type && SEMANTIC_RISKY_TYPES.has(params.semantic_type)) ||
            (params.control_model && SEMANTIC_RISKY_TYPES.has(params.control_model));
          if (params.force_confirm || risky) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  error: "confirm_required",
                  reason: params.force_confirm ? "force_confirm" : "risky_override",
                  action: {
                    kind: "semantic_override",
                    action: {
                      scope,
                      id: target,
                      semantic_type: params.semantic_type,
                      control_model: params.control_model,
                      smoke_test_safe: params.smoke_test_safe,
                      notes: params.notes,
                    },
                  },
                  assistant_reply:
                    "Potrebna je potvrda. Koristi ha_prepare_risky_action + ha_confirm_action.",
                  assistant_reply_short: "Potrebna je potvrda.",
                },
                null,
                2,
              ),
            );
          }
          const overrides = await loadSemanticOverrides();
          const entry: SemanticOverrideEntry = {
            semantic_type: params.semantic_type,
            control_model: params.control_model,
            smoke_test_safe: params.smoke_test_safe,
            notes: params.notes,
            ts: new Date().toISOString(),
          };
          if (scope === "entity") {
            overrides.entity_overrides[target] = { ...overrides.entity_overrides[target], ...entry };
          } else {
            overrides.device_overrides[target] = { ...overrides.device_overrides[target], ...entry };
          }
          await saveSemanticOverrides(overrides);

          await traceToolCall({
            tool: "ha_upsert_semantic_override",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "semantic_overrides",
          });

          return textResult(
            JSON.stringify(
              { ok: true, scope, id: target, entry, path: SEMANTIC_OVERRIDES_PATH },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_upsert_semantic_override",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "semantic_overrides",
            error: err,
          });
          return textResult(`HA upsert_semantic_override error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_semantic_resolve",
      description: "Resolve semantic metadata for a specific entity or query.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          query: { type: "string" },
          area: { type: "string" },
          domain: { type: "string" },
          device_id: { type: "string" },
        },
      },
      async execute(
        _id: string,
        params: { entity_id?: string; query?: string; area?: string; domain?: string; device_id?: string },
      ) {
        const started = Date.now();
        try {
          const snapshot = await fetchInventorySnapshot();
          const learnedStore = await loadLearnedSemanticMap();
          const semanticMap = await buildSemanticMapFromSnapshot(snapshot);
          const brain = await buildDeviceBrainResult({
            snapshot,
            learnedStore,
            semanticMap: semanticMap.by_entity,
            target: {
              entity_id: params.entity_id,
              name: params.query,
              area: params.area,
              device_id: params.device_id,
              domain: params.domain,
            },
          });
          const target = brain.best ? snapshot.entities[brain.best.entity_id] : null;
          if (!target) {
            return textResult(
              JSON.stringify({ ok: false, reason: "not_found", candidates: [] }, null, 2),
            );
          }
          const resolution = semanticMap.by_entity[target.entity_id];
          await traceToolCall({
            tool: "ha_semantic_resolve",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "semantic_resolve",
            resultBytes: Buffer.byteLength(JSON.stringify(brain), "utf8"),
          });
          return textResult(
            JSON.stringify(
              {
                ok: true,
                entity_id: target.entity_id,
                semantic: resolution,
                candidates: brain.candidates,
                best: brain.best,
                needs_confirmation: brain.needs_confirmation,
                requested_semantic: brain.requested_semantic,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_semantic_resolve",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "semantic_resolve",
            error: err,
          });
          return textResult(`HA semantic_resolve error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_semantic_explain",
      description: "Explain semantic classification for an entity or query.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          query: { type: "string" },
          area: { type: "string" },
          domain: { type: "string" },
          device_id: { type: "string" },
        },
      },
      async execute(
        _id: string,
        params: { entity_id?: string; query?: string; area?: string; domain?: string; device_id?: string },
      ) {
        const started = Date.now();
        try {
          const snapshot = await fetchInventorySnapshot();
          const semanticMap = await buildSemanticMapFromSnapshot(snapshot);
          const learnedStore = await loadLearnedSemanticMap();
          const brain = await buildDeviceBrainResult({
            snapshot,
            learnedStore,
            semanticMap: semanticMap.by_entity,
            target: {
              entity_id: params.entity_id,
              name: params.query,
              area: params.area,
              device_id: params.device_id,
              domain: params.domain,
            },
          });
          const target = brain.best ? snapshot.entities[brain.best.entity_id] : null;
          if (!target) {
            return textResult(
              JSON.stringify(
                { ok: false, reason: "not_found", candidates: brain.candidates.slice(0, 5) },
                null,
                2,
              ),
            );
          }
          const resolution = semanticMap.by_entity[target.entity_id];
          const graphKey = deviceGraphKeyForEntity(target);
          const deviceGraph = snapshot.device_graph?.[graphKey] ?? null;
          await traceToolCall({
            tool: "ha_semantic_explain",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "semantic_explain",
            resultBytes: Buffer.byteLength(JSON.stringify(resolution ?? {}), "utf8"),
          });
          return textResult(
            JSON.stringify(
              {
                ok: true,
                entity_id: target.entity_id,
                semantic: resolution,
                device_graph: deviceGraph,
                missing_signals: resolution?.missing_signals ?? [],
                reasons: resolution?.reasons ?? [],
                non_actionable: resolution?.non_actionable ?? false,
                candidates: brain.candidates.slice(0, 5),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_semantic_explain",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "semantic_explain",
            error: err,
          });
          return textResult(`HA semantic_explain error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_risk_policy_get",
      description: "Return the current risk policy configuration.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const policy = await loadRiskPolicy();
          await traceToolCall({
            tool: "ha_risk_policy_get",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "risk_policy",
            resultBytes: Buffer.byteLength(JSON.stringify(policy), "utf8"),
          });
          return textResult(
            JSON.stringify(
              {
                ok: true,
                path: RISK_POLICY_PATH,
                policy,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_risk_policy_get",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "risk_policy",
            error: err,
          });
          return textResult(`HA risk_policy_get error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_risk_policy_upsert_rule",
      description: "Add or update a risk policy rule.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          rule_id: { type: "string" },
          scope: { type: "string" },
          id: { type: "string" },
          domain: { type: "string" },
          action: { type: "string" },
          decision: { type: "string" },
          bounds: { type: "object", additionalProperties: true },
          conditions: { type: "object", additionalProperties: true },
          note: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["scope", "id", "domain", "action", "decision"],
      },
      async execute(
        _id: string,
        params: {
          rule_id?: string;
          scope: string;
          id: string;
          domain: string;
          action: string;
          decision: string;
          bounds?: RiskPolicyBounds;
          conditions?: RiskPolicyConditions;
          note?: string;
          force?: boolean;
        },
      ) {
        const started = Date.now();
        try {
          const policy = await loadRiskPolicy();
          const ruleId = params.rule_id?.trim() || randomUUID();
          const rule: RiskPolicyRule = {
            rule_id: ruleId,
            scope: params.scope as RiskPolicyRule["scope"],
            id: params.id,
            domain: params.domain,
            action: params.action,
            decision: params.decision as RiskPolicyDecision,
            bounds: params.bounds,
            conditions: params.conditions,
            note: params.note,
            force: params.force ?? false,
          };
          const idx = policy.rules.findIndex((entry) => entry.rule_id === ruleId);
          if (idx >= 0) {
            policy.rules[idx] = rule;
          } else {
            policy.rules.push(rule);
          }
          await saveRiskPolicy(policy);
          await traceToolCall({
            tool: "ha_risk_policy_upsert_rule",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "risk_policy",
          });
          return textResult(JSON.stringify({ ok: true, rule, path: RISK_POLICY_PATH }, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_risk_policy_upsert_rule",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "risk_policy",
            error: err,
          });
          return textResult(`HA risk_policy_upsert_rule error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_risk_policy_set_preset",
      description: "Apply the BOG preset risk policy defaults.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const policy = await loadRiskPolicy();
          policy.defaults = DEFAULT_RISK_POLICY.defaults;
          await saveRiskPolicy(policy);
          await traceToolCall({
            tool: "ha_risk_policy_set_preset",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "risk_policy",
          });
          return textResult(JSON.stringify({ ok: true, policy, path: RISK_POLICY_PATH }, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_risk_policy_set_preset",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "risk_policy",
            error: err,
          });
          return textResult(`HA risk_policy_set_preset error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_risk_policy_explain",
      description: "Explain how the risk policy would evaluate a target + intent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "object", additionalProperties: true },
          intent: { type: "object", additionalProperties: true },
          data: { type: "object", additionalProperties: true },
        },
        required: ["target"],
      },
      async execute(
        _id: string,
        params: {
          target: { entity_id?: string; name?: string; area?: string; device_id?: string; domain?: string };
          intent?: { action?: string; value?: unknown; property?: string };
          data?: Record<string, unknown>;
        },
      ) {
        const started = Date.now();
        try {
          const snapshot = await fetchInventorySnapshot();
          const semanticMap = await buildSemanticMapFromSnapshot(snapshot);
          const learnedStore = await loadLearnedSemanticMap();
          const brain = await buildDeviceBrainResult({
            snapshot,
            learnedStore,
            semanticMap: semanticMap.by_entity,
            intentProperty: params.intent?.property ?? "",
            target: {
              entity_id: params.target.entity_id,
              name: params.target.name,
              area: params.target.area,
              device_id: params.target.device_id,
              domain: params.target.domain,
            },
          });
          const target = brain.best ? snapshot.entities[brain.best.entity_id] : null;
          if (!target) {
            return textResult(JSON.stringify({ ok: false, reason: "target_not_found" }, null, 2));
          }
          const overrides = await loadSemanticOverrides();
          const deviceEntities = Object.values(snapshot.entities).filter(
            (entry) => entry.device_id && entry.device_id === target.device_id,
          );
          const resolution =
            semanticMap.by_entity[target.entity_id] ??
            buildSemanticResolution({
              entity: target,
              deviceEntities,
              overrides,
              learnedStore,
              servicesByDomain: snapshot.services_by_domain ?? {},
              deviceGraph: snapshot.device_graph ?? {},
            });
          const actionTarget = pickActionTargetEntity({
            target,
            resolution,
            snapshot,
            semanticMap: semanticMap.by_entity,
          });
          const actionResolution =
            semanticMap.by_entity[actionTarget.entity_id] ??
            buildSemanticResolution({
              entity: actionTarget,
              deviceEntities,
              overrides,
              learnedStore,
              servicesByDomain: snapshot.services_by_domain ?? {},
              deviceGraph: snapshot.device_graph ?? {},
            });
          const intent = params.intent ?? {};
          const data = params.data ?? {};
          const plan = buildUniversalPlan({ entity: actionTarget, resolution: actionResolution, intent, data });
          const payload = buildServicePayload({ entity_id: [actionTarget.entity_id] }, plan.payload);
          const normalized = await normalizeFriendlyServiceCall({
            domain: plan.domain,
            service: plan.service,
            payload,
            entityIds: [actionTarget.entity_id],
            semanticType: actionResolution.semantic_type,
          });
          const primary = {
            domain: plan.domain,
            service: normalized.service,
            payload: normalized.payload,
          };
          const currentState = await fetchEntityState(actionTarget.entity_id);
          const policy = await loadRiskPolicy();
          const state = await loadRiskPolicyState();
          const reliabilityStats = await loadReliabilityStats();
          const evalResult = await evaluateRiskPolicy({
            policy,
            state,
            target: actionTarget,
            actionPlan: primary,
            intent,
            currentState,
            reliabilityStats: reliabilityStats[`${actionTarget.entity_id}:${primary.domain}.${primary.service}`],
          });
          await traceToolCall({
            tool: "ha_risk_policy_explain",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "risk_policy",
          });
          return textResult(
            JSON.stringify(
              {
                ok: true,
                target_entity_id: target.entity_id,
                action_entity_id: actionTarget.entity_id,
                action_plan: primary,
                action_key: evalResult.action_key,
                decision: evalResult.decision,
                reasons: evalResult.reasons,
                matched_rule: evalResult.matched_rule ?? null,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_risk_policy_explain",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "risk_policy",
            error: err,
          });
          return textResult(`HA risk_policy_explain error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_inventory_report",
      description: "Generate a compact inventory report + semantic map.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_raw: { type: "boolean" },
        },
      },
      async execute(_id: string, params: { include_raw?: boolean }) {
        const started = Date.now();
        try {
          const snapshot = await fetchInventorySnapshot();
          const semanticMap = await buildSemanticMapFromSnapshot(snapshot);
          const learnedStore = await loadLearnedSemanticMap();
          const riskApprovals = await loadRiskApprovals();
          const reliabilityStats = await loadReliabilityStats();
          const riskPolicy = await loadRiskPolicy();
          const actionableEntries = Object.values(semanticMap.by_entity).filter(
            (entry) => !entry.non_actionable,
          );
          const totalEntities = actionableEntries.length || 1;
          const resolvedEntities = actionableEntries.filter((entry) => entry.ambiguity.ok).length;
          const noJebanciScore = Math.round((resolvedEntities / totalEntities) * 1000) / 10;
          const ambiguousList = Object.entries(semanticMap.by_entity)
            .filter(([, entry]) => !entry.non_actionable && !entry.ambiguity.ok)
            .slice(0, 25)
            .map(([entityId, entry]) => ({
              entity_id: entityId,
              semantic_type: entry.semantic_type,
              confidence: entry.confidence,
              reasons: entry.reasons,
              missing_signals: entry.missing_signals,
              ambiguity: entry.ambiguity,
            }));
          const telemetryVacuumList = Object.entries(semanticMap.by_entity)
            .filter(([, entry]) => entry.non_actionable && entry.semantic_type === "telemetry.vacuum")
            .slice(0, 25)
            .map(([entityId, entry]) => ({
              entity_id: entityId,
              semantic_type: entry.semantic_type,
              reasons: entry.reasons,
              missing_signals: entry.missing_signals,
            }));
          const riskPolicyCounts = actionableEntries.reduce(
            (acc, entry) => {
              const primary = entry.recommended_primary ?? "";
              const [domain, service] = primary.split(".");
              const actionKey = resolveCanonicalActionKey({
                domain: domain || entry.semantic_type,
                service: service || "",
              });
              const decision = resolvePolicyDefault(riskPolicy, normalizeName(domain || entry.semantic_type), actionKey).decision;
              acc[decision] = (acc[decision] ?? 0) + 1;
              return acc;
            },
            {} as Record<RiskPolicyDecision, number>,
          );
          const confirmDefaults = Object.entries(riskPolicy.defaults)
            .flatMap(([domain, actions]) =>
              Object.entries(actions)
                .filter(([, rule]) => rule.decision === "confirm")
                .map(([action]) => `${domain}.${action}`),
            )
            .filter((entry) => !entry.includes("*.") && !entry.endsWith(".*"))
            .slice(0, 10);
          const needsOverrideLines = semanticMap.needs_override
            .slice(0, 20)
            .map((entry) => `- ${entry.entity_id}: ${entry.reason}`);
          const telemetryVacuumLines = telemetryVacuumList
            .map((entry) => `- ${entry.entity_id}: ${entry.semantic_type}`)
            .join("\n");
          const riskPolicyLines = [
            `- auto_approve: ${riskPolicyCounts.auto_approve ?? 0}`,
            `- confirm: ${riskPolicyCounts.confirm ?? 0}`,
            `- readonly_only: ${riskPolicyCounts.readonly_only ?? 0}`,
            `- deny: ${riskPolicyCounts.deny ?? 0}`,
          ];
          const confirmDefaultsLines = confirmDefaults.map((entry) => `- ${entry}`);
          const report = [
            "# HA Inventory Report",
            "",
            `Generated: ${snapshot.generated_at}`,
            "",
            `Entities: ${Object.keys(snapshot.entities).length}`,
            `Actionable Entities: ${actionableEntries.length}`,
            `Domains: ${Object.keys(snapshot.services_by_domain ?? {}).length}`,
            `NO_JEBANCI_SCORE: ${noJebanciScore}%`,
            "",
            "## Risk Policy Summary",
            ...riskPolicyLines,
            "",
            "## Risky Actions (Confirm By Default)",
            confirmDefaultsLines.length > 0 ? confirmDefaultsLines.join("\n") : "- none",
            "",
            "## Needs Override",
            needsOverrideLines.length > 0 ? needsOverrideLines.join("\n") : "- none",
            "",
            "## Telemetry (Vacuum)",
            telemetryVacuumLines.length > 0 ? telemetryVacuumLines : "- none",
            "",
            "## Ambiguous (Top 25)",
            ambiguousList.length > 0
              ? ambiguousList
                  .map((entry) => `- ${entry.entity_id}: ${entry.semantic_type} (${entry.confidence})`)
                  .join("\n")
              : "- none",
          ].join("\n");
          await traceToolCall({
            tool: "ha_inventory_report",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "inventory_report",
            resultBytes: Buffer.byteLength(report, "utf8"),
          });
          return textResult(
            JSON.stringify(
              {
                ok: true,
                report_md: report,
                semantic_map: semanticMap,
                no_jebanci_score: noJebanciScore,
                ambiguous: ambiguousList,
                telemetry_vacuum: telemetryVacuumList,
                risk_policy_summary: {
                  counts: riskPolicyCounts,
                  confirm_defaults: confirmDefaults,
                },
                learned_map: learnedStore,
                risk_approvals: riskApprovals,
                reliability_stats: reliabilityStats,
                inventory_snapshot: params.include_raw ? snapshot : undefined,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_inventory_report",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "inventory_report",
            error: err,
          });
          return textResult(`HA inventory_report error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_universal_control",
      description: "Universal HA control with semantic resolution and verification.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "object", additionalProperties: true },
          intent: { type: "object", additionalProperties: true },
          data: { type: "object", additionalProperties: true },
          dry_run: { type: "boolean" },
          safe_probe: { type: "boolean" },
          force_confirm: { type: "boolean" },
          deadline_ms: { type: "number" },
          verify_timeout_ms: { type: "number" },
          ha_timeout_ms: { type: "number" },
        },
        required: ["target"],
      },
      async execute(
        _id: string,
        params: {
          target: { entity_id?: string; name?: string; area?: string; device_id?: string; domain?: string };
          intent?: { action?: string; value?: unknown; property?: string };
          data?: Record<string, unknown>;
          dry_run?: boolean;
          safe_probe?: boolean;
          force_confirm?: boolean;
          deadline_ms?: number;
          verify_timeout_ms?: number;
          ha_timeout_ms?: number;
        },
      ) {
        const started = Date.now();
        const stage = { value: "start" };
        const requestedDeadlineMs = params.deadline_ms ?? (params.safe_probe ? 20000 : 60000);
        const deadlineMs = clampTimeout(requestedDeadlineMs, 6000, 60000);
        const baseVerifyTimeoutMs = params.verify_timeout_ms ?? (params.safe_probe ? 8000 : 15000);
        const baseHaTimeoutMs = params.ha_timeout_ms ?? (params.safe_probe ? 4000 : 8000);
        const timing: { deadline_ms: number; verify_timeout_ms: number; ha_timeout_ms: number; ha_latency_ms: number | null } =
          {
            deadline_ms: deadlineMs,
            verify_timeout_ms: baseVerifyTimeoutMs,
            ha_timeout_ms: baseHaTimeoutMs,
            ha_latency_ms: null,
          };
        const retryDelays = [250, 750];
        try {
          return await withDeadline({
            label: "ha_universal_control",
            deadlineMs,
            getStage: () => stage.value,
            fn: async () => {
              stage.value = "ping";
              const pingStarted = Date.now();
              const pingTimeoutMs = clampTimeout(baseHaTimeoutMs, 2000, Math.min(15000, deadlineMs - 1000));
              const ping = await requestJsonWithRetry(
                {
                  method: "GET",
                  url: `${getHaBaseUrl()}/api/config`,
                  token: getHaToken(),
                  timeoutMs: pingTimeoutMs,
                },
                retryDelays,
              );
              const haLatencyMs = Date.now() - pingStarted;
              timing.ha_latency_ms = haLatencyMs;
              timing.ha_timeout_ms = clampTimeout(
                Math.max(baseHaTimeoutMs, Math.round(haLatencyMs * 1.5)),
                2000,
                Math.min(20000, deadlineMs - 1000),
              );
              if (!ping.res.ok) {
                return textResult(
                  JSON.stringify(
                    { ok: false, reason: "ha_unreachable", ha_attempts: ping.attempts },
                    null,
                    2,
                  ),
                );
              }

              stage.value = "snapshot";
              const snapshot = await fetchInventorySnapshot();
              const semanticMap = await buildSemanticMapFromSnapshot(snapshot);
              const learnedStore = await loadLearnedSemanticMap();
              const brain = await buildDeviceBrainResult({
                snapshot,
                learnedStore,
                semanticMap: semanticMap.by_entity,
                intentProperty: params.intent?.property ?? "",
                target: {
                  entity_id: params.target.entity_id,
                  name: params.target.name,
                  area: params.target.area,
                  device_id: params.target.device_id,
                  domain: params.target.domain,
                },
              });
              const target = brain.best ? snapshot.entities[brain.best.entity_id] : null;
              if (!target) {
                return textResult(
                  JSON.stringify({ ok: false, reason: "target_not_found", candidates: brain.candidates }, null, 2),
                );
              }
              if (brain.needs_confirmation && !params.force_confirm && !params.safe_probe) {
                return textResult(
                  JSON.stringify(
                    {
                      ok: false,
                      error: "confirm_required",
                      reason: "ambiguous_target",
                      candidates: brain.candidates.slice(0, 5),
                      assistant_reply:
                        "Više kandidata odgovara. Molim odaberi točan uređaj.",
                      assistant_reply_short: "Trebam izbor uređaja.",
                    },
                    null,
                    2,
                  ),
                );
              }
              const overrides = await loadSemanticOverrides();
              const deviceEntities = Object.values(snapshot.entities).filter(
                (entry) => entry.device_id && entry.device_id === target.device_id,
              );
              const resolution = semanticMap.by_entity[target.entity_id] ?? buildSemanticResolution({
                entity: target,
                deviceEntities,
                overrides,
                learnedStore,
                servicesByDomain: snapshot.services_by_domain ?? {},
                deviceGraph: snapshot.device_graph ?? {},
              });
              const actionTarget = pickActionTargetEntity({
                target,
                resolution,
                snapshot,
                semanticMap: semanticMap.by_entity,
              });
              const actionResolution =
                semanticMap.by_entity[actionTarget.entity_id] ??
                buildSemanticResolution({
                  entity: actionTarget,
                  deviceEntities,
                  overrides,
                  learnedStore,
                  servicesByDomain: snapshot.services_by_domain ?? {},
                  deviceGraph: snapshot.device_graph ?? {},
                });
              const telemetryEntitiesUsed = deviceEntities
                .filter((entry) => semanticMap.by_entity[entry.entity_id]?.non_actionable)
                .map((entry) => entry.entity_id);
              const maxVerifyTimeoutMs = Math.max(2000, deadlineMs - 1000);
              const lowRiskBase = getLowRiskVerifyTimeoutMs(actionResolution.semantic_type, actionTarget.domain);
              const latencyBoost = Math.min((timing.ha_latency_ms ?? 0) * 2, params.safe_probe ? 5000 : 15000);
              const desiredVerifyTimeoutMs = lowRiskBase
                ? Math.max(baseVerifyTimeoutMs, lowRiskBase + latencyBoost)
                : Math.max(baseVerifyTimeoutMs, Math.min((timing.ha_latency_ms ?? 0) * 2, 8000));
              const verifyTimeoutMs = clampTimeout(desiredVerifyTimeoutMs, 2000, maxVerifyTimeoutMs);
              timing.verify_timeout_ms = verifyTimeoutMs;
              const riskLevel = getRiskLevel(actionResolution.semantic_type, actionTarget.domain);
              if (params.safe_probe) {
                if (riskLevel === "high") {
                  const beforeState = await fetchEntityState(actionTarget.entity_id);
                  return textResult(
                    JSON.stringify(
                      {
                        ok: true,
                        target: target.entity_id,
                        action_entity_id: actionTarget.entity_id,
                        semantic: actionResolution,
                        semantic_explain: {
                          target_entity_id: target.entity_id,
                          target_semantic: resolution,
                          action_entity_id: actionTarget.entity_id,
                          action_semantic: actionResolution,
                        },
                        telemetry_entities_used: telemetryEntitiesUsed,
                        read_only: true,
                        verification: {
                          attempted: false,
                          ok: true,
                          level: "state",
                          method: "state_poll",
                          reason: "read_only_probe",
                          targets: [actionTarget.entity_id],
                          before: beforeState ? { [actionTarget.entity_id]: beforeState } : null,
                          after: beforeState ? { [actionTarget.entity_id]: beforeState } : null,
                        },
                        risk_level: riskLevel,
                        timing,
                      },
                      null,
                      2,
                    ),
                  );
                }
                stage.value = "probe";
                const probe = await runReversibleProbe(actionTarget, actionResolution, verifyTimeoutMs);
                return textResult(
                  JSON.stringify(
                    {
                      ok: probe.ok,
                      target: target.entity_id,
                      action_entity_id: actionTarget.entity_id,
                      semantic: actionResolution,
                      semantic_explain: {
                        target_entity_id: target.entity_id,
                        target_semantic: resolution,
                        action_entity_id: actionTarget.entity_id,
                        action_semantic: actionResolution,
                      },
                      telemetry_entities_used: telemetryEntitiesUsed,
                      probe,
                      verification: probe.verification,
                      risk_level: riskLevel,
                      timing,
                    },
                    null,
                    2,
                  ),
                );
              }

              stage.value = "plan";
              const currentState = await fetchEntityState(actionTarget.entity_id);
              const intent = params.intent ?? {};
              const data = params.data ?? {};
              const plan = buildUniversalPlan({ entity: actionTarget, resolution: actionResolution, intent, data });
          const explicitIntent = Boolean(intent.property || intent.value !== undefined);
          let selectedPlan = plan;
          let reliabilityPreference: { from: string; to: string } | null = null;
          if (!explicitIntent) {
            const preferred = await pickReliableService({
              entityId: actionTarget.entity_id,
              primary: { domain: plan.domain, service: plan.service },
              fallbacks: plan.fallbacks.map((fallback) => ({ domain: fallback.domain, service: fallback.service })),
            });
            if (preferred) {
              const fallbackMatch = plan.fallbacks.find(
                (fallback) => fallback.domain === preferred.domain && fallback.service === preferred.service,
              );
              selectedPlan = {
                ...plan,
                domain: preferred.domain,
                service: preferred.service,
                payload: fallbackMatch?.payload ?? plan.payload,
              };
              reliabilityPreference = {
                from: `${plan.domain}.${plan.service}`,
                to: `${preferred.domain}.${preferred.service}`,
              };
            }
          }
              const basePayload = buildServicePayload({ entity_id: [actionTarget.entity_id] }, selectedPlan.payload);
              const normalized = await normalizeFriendlyServiceCall({
                domain: selectedPlan.domain,
                service: selectedPlan.service,
                payload: basePayload,
                entityIds: [actionTarget.entity_id],
                semanticType: actionResolution.semantic_type,
              });
          const primary = {
            domain: selectedPlan.domain,
            service: normalized.service,
            payload: normalized.payload,
            warnings: normalized.warnings ?? [],
            unsupported: normalized.unsupported ?? [],
            normalization_fallback: normalized.fallback ?? null,
          };
          const capabilityMismatch: string[] = [];
          if (primary.unsupported.length > 0) {
            capabilityMismatch.push(`unsupported:${primary.unsupported.join(",")}`);
          }
          if (primary.normalization_fallback?.reason) {
            capabilityMismatch.push(`fallback:${String(primary.normalization_fallback.reason)}`);
          }
          if (primary.domain === "light" && primary.service === "turn_on") {
            const servicesRes = await fetchServices();
            const fields = servicesRes.ok ? getServiceFields(servicesRes.data, "light", "turn_on") : {};
            const state = await fetchEntityState(actionTarget.entity_id);
            const request = extractLightRequest(primary.payload);
            const capabilities = buildLightCapabilities(state);
            const normalizedLight = normalizeLightTurnOnPayload(primary.payload, fields, capabilities, request);
            replacePayload(primary.payload, normalizedLight.normalized);
            primary.warnings.push(...normalizedLight.warnings);
            primary.unsupported.push(...normalizedLight.unsupported);
            const colored = applyRequestedColor({
              payload: primary.payload,
              request,
              capabilities,
            });
            replacePayload(primary.payload, colored.payload);
            delete primary.payload.color;
            delete primary.payload.color_name;
            primary.warnings.push(...colored.warnings);
            primary.unsupported.push(...colored.unsupported);
          }
              if (params.dry_run) {
                return textResult(
                  JSON.stringify(
                    {
                      ok: true,
                      dry_run: true,
                      target: target.entity_id,
                      action_entity_id: actionTarget.entity_id,
                      semantic: actionResolution,
                      semantic_explain: {
                        target_entity_id: target.entity_id,
                        target_semantic: resolution,
                        action_entity_id: actionTarget.entity_id,
                        action_semantic: actionResolution,
                      },
                      telemetry_entities_used: telemetryEntitiesUsed,
                      plan: primary,
                      fallbacks: plan.fallbacks,
                      capability_mismatch: capabilityMismatch,
                    },
                    null,
                    2,
                  ),
                );
              }

              const riskPolicy = await loadRiskPolicy();
              const riskPolicyState = await loadRiskPolicyState();
              const reliabilityStatsMap = await loadReliabilityStats();
              const riskEval = await evaluateRiskPolicy({
                policy: riskPolicy,
                state: riskPolicyState,
                target: actionTarget,
                actionPlan: { domain: primary.domain, service: primary.service, payload: primary.payload },
                intent,
                currentState,
                reliabilityStats: reliabilityStatsMap[`${actionTarget.entity_id}:${primary.domain}.${primary.service}`],
                isReadOnly: false,
              });

              if (riskEval.decision === "deny") {
                return textResult(
                  JSON.stringify(
                    {
                      ok: false,
                      error: "denied",
                      reason: "risk_policy_denied",
                      target: target.entity_id,
                      action_entity_id: actionTarget.entity_id,
                      semantic: actionResolution,
                      semantic_explain: {
                        target_entity_id: target.entity_id,
                        target_semantic: resolution,
                        action_entity_id: actionTarget.entity_id,
                        action_semantic: actionResolution,
                      },
                      telemetry_entities_used: telemetryEntitiesUsed,
                      risk_decision: riskEval.decision,
                      risk_reason: riskEval.reasons,
                      risk_rule_matched: riskEval.matched_rule ?? null,
                    },
                    null,
                    2,
                  ),
                );
              }

              if (riskEval.decision === "readonly_only") {
                const beforeState = await fetchEntityState(actionTarget.entity_id);
                return textResult(
                  JSON.stringify(
                    {
                      ok: true,
                      read_only: true,
                      target: target.entity_id,
                      action_entity_id: actionTarget.entity_id,
                      semantic: actionResolution,
                      semantic_explain: {
                        target_entity_id: target.entity_id,
                        target_semantic: resolution,
                        action_entity_id: actionTarget.entity_id,
                        action_semantic: actionResolution,
                      },
                      telemetry_entities_used: telemetryEntitiesUsed,
                      risk_decision: riskEval.decision,
                      risk_reason: riskEval.reasons,
                      risk_rule_matched: riskEval.matched_rule ?? null,
                      verification: {
                        attempted: false,
                        ok: true,
                        level: "state",
                        method: "state_poll",
                        reason: "policy_readonly",
                        targets: [actionTarget.entity_id],
                        before: beforeState ? { [actionTarget.entity_id]: beforeState } : null,
                        after: beforeState ? { [actionTarget.entity_id]: beforeState } : null,
                      },
                      timing,
                    },
                    null,
                    2,
                  ),
                );
              }

              if (riskEval.decision === "confirm" && !params.force_confirm) {
                return textResult(
                  JSON.stringify(
                    {
                      ok: false,
                      error: "confirm_required",
                      reason: "risk_policy_confirm",
                      target: target.entity_id,
                      action_entity_id: actionTarget.entity_id,
                      semantic: actionResolution,
                      semantic_explain: {
                        target_entity_id: target.entity_id,
                        target_semantic: resolution,
                        action_entity_id: actionTarget.entity_id,
                        action_semantic: actionResolution,
                      },
                      telemetry_entities_used: telemetryEntitiesUsed,
                      risk_decision: riskEval.decision,
                      risk_reason: riskEval.reasons,
                      risk_rule_matched: riskEval.matched_rule ?? null,
                      assistant_reply:
                        "Potrebna je potvrda. Koristi ha_prepare_risky_action + ha_confirm_action.",
                      assistant_reply_short: "Potrebna je potvrda.",
                    },
                    null,
                    2,
                  ),
                );
              }

              stage.value = "execute";
              const attempts: Array<Record<string, unknown>> = [];
              const beforeState = currentState ?? (await fetchEntityState(actionTarget.entity_id));
              let result = await executeServiceCallWithVerification({
                domain: primary.domain,
                service: primary.service,
                payload: primary.payload,
                entityIds: [actionTarget.entity_id],
                normalizationFallback: primary.normalization_fallback,
                verifyTimeoutMs,
                wsTimeoutMs: verifyTimeoutMs,
                allowEventVerification: isLowRiskVerificationTarget(actionResolution.semantic_type, primary.domain),
              });
          attempts.push({
            kind: "primary",
            domain: primary.domain,
            service: primary.service,
            verification: result.verification,
          });

          let fallbackUsed = false;
          let fallbackReason: string | null = null;
              if (!result.verification.ok && plan.fallbacks.length > 0) {
                const fallback = plan.fallbacks[0];
                const fallbackPayload = buildServicePayload(
                  { entity_id: [actionTarget.entity_id] },
                  fallback.payload,
                );
                const fallbackResult = await executeServiceCallWithVerification({
                  domain: fallback.domain,
                  service: fallback.service,
                  payload: fallbackPayload,
                  entityIds: [actionTarget.entity_id],
                  verifyTimeoutMs,
                  wsTimeoutMs: verifyTimeoutMs,
                  allowEventVerification: isLowRiskVerificationTarget(actionResolution.semantic_type, fallback.domain),
                });
            attempts.push({
              kind: "fallback",
              domain: fallback.domain,
              service: fallback.service,
              reason: fallback.reason,
              verification: fallbackResult.verification,
            });
            if (fallbackResult.verification.ok) {
              result = fallbackResult;
              fallbackUsed = true;
              fallbackReason = fallback.reason;
            }
          }

              const levelScore =
                result.verification.level === "state"
                  ? 1
                  : result.verification.level === "ha_event"
                    ? 0.7
                    : 0.2;
              const capabilityScore = primary.unsupported.length === 0 ? 1 : 0.6;
              const reliability =
                Math.round(((actionResolution.confidence + capabilityScore + levelScore) / 3) * 100) / 100;

              const intentLabel = `${normalizeName(intent.action ?? "")}:${normalizeName(intent.property ?? "")}`;
              const statsKey = `${actionTarget.entity_id}:${primary.domain}.${primary.service}`;
              const statsReason = capabilityMismatch.length > 0 ? `capability_mismatch:${capabilityMismatch.join("|")}` : result.verification.reason;
              stage.value = "learn";
              const stats = await updateSemanticStats(statsKey, result.verification.ok, statsReason);
              const reliabilityStats = await updateReliabilityStats({
                entityId: actionTarget.entity_id,
                actionKind: `${primary.domain}.${primary.service}`,
                ok: result.verification.ok,
                latencyMs: Date.now() - started,
                verificationLevel: result.verification.level,
                serviceVariant: `${primary.domain}.${primary.service}`,
              });
              if (riskLevel === "high" && result.verification.ok) {
                await recordRiskApproval({
                  entityId: actionTarget.entity_id,
                  actionKind: `${primary.domain}.${primary.service}`,
                  note: "verified_action",
                });
              }
              const learned = await updateLearnedSemanticMap({
                entityId: actionTarget.entity_id,
                semanticType: actionResolution.semantic_type,
                controlModel: actionResolution.control_model,
                intentLabel,
                ok: result.verification.ok,
                deviceFingerprint: actionTarget.device_fingerprint,
              });
              await recordRiskPolicyAction(actionTarget.entity_id, riskEval.action_key);
              const learnedAlias = params.target.name
                ? await updateLearnedAliasMap({
                    alias: params.target.name,
                    entityId: actionTarget.entity_id,
                    deviceId: actionTarget.device_id,
                    semanticType: actionResolution.semantic_type,
                    intentLabel,
                    ok: result.verification.ok,
                  })
                : null;

          const restorePlan: Record<string, unknown> | null = (() => {
            if (!beforeState) return null;
            if (primary.domain === "media_player" && primary.service === "volume_set") {
              const prevVolume = toNumberLoose(beforeState.attributes?.["volume_level"]);
              if (prevVolume !== undefined) {
                return {
                  target: { entity_id: actionTarget.entity_id },
                  intent: { action: "set", property: "volume", value: Math.round(prevVolume * 100) },
                };
              }
            }
            if (primary.domain === "light" && primary.service === "turn_on") {
              const prevBrightness = toNumberLoose(beforeState.attributes?.["brightness"]);
              if (prevBrightness !== undefined) {
                return {
                  target: { entity_id: actionTarget.entity_id },
                  intent: { action: "set", property: "brightness", value: prevBrightness },
                };
              }
            }
            return null;
          })();

              await traceToolCall({
                tool: "ha_universal_control",
                params,
                durationMs: Date.now() - started,
                ok: result.verification.ok,
                endpoint: `${primary.domain}.${primary.service}`,
              });

              return textResult(
                JSON.stringify(
                  {
                    ok: result.verification.ok,
                    target: target.entity_id,
                    action_entity_id: actionTarget.entity_id,
                    candidates: brain.candidates.slice(0, 5),
                    requested_semantic: brain.requested_semantic,
                    semantic: actionResolution,
                    semantic_explain: {
                      target_entity_id: target.entity_id,
                      target_semantic: resolution,
                      action_entity_id: actionTarget.entity_id,
                      action_semantic: actionResolution,
                    },
                    telemetry_entities_used: telemetryEntitiesUsed,
                    risk_decision: riskEval.decision,
                    risk_reason: riskEval.reasons,
                    risk_rule_matched: riskEval.matched_rule ?? null,
                    plan: primary,
                    attempts,
                    fallback_used: fallbackUsed,
                    fallback_reason: fallbackReason,
                    verification: result.verification,
                    reliability: {
                      score: reliability,
                      semantic_confidence: actionResolution.confidence,
                      capability_confidence: capabilityScore,
                      verification_strength: levelScore,
                      stats,
                      reliability_stats: reliabilityStats,
                    },
                    reliability_preference: reliabilityPreference,
                    restore_plan: restorePlan,
                    capability_mismatch: capabilityMismatch,
                    learned,
                    learned_alias: learnedAlias,
                    timing,
                  },
                  null,
                  2,
                ),
              );
            },
          });
        } catch (err) {
          if (err instanceof DeadlineError) {
            const reason = params.safe_probe ? "probe_skipped_due_to_latency" : "deadline_exceeded";
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  error: "deadline_exceeded",
                  reason,
                  retryable: true,
                  timing,
                  verification: {
                    attempted: true,
                    ok: false,
                    level: "none",
                    method: "none",
                    reason,
                    targets: params.target.entity_id ? [params.target.entity_id] : [],
                    before: null,
                    after: null,
                    evidence: {
                      stage: err.stage,
                      elapsed_ms: err.elapsedMs,
                      deadline_ms: deadlineMs,
                    },
                  },
                },
                null,
                2,
              ),
            );
          }
          await traceToolCall({
            tool: "ha_universal_control",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "ha_universal_control",
            error: err,
          });
          return textResult(
            JSON.stringify(
              {
                ok: false,
                error: "gateway_internal_error",
                reason: String(err),
                retryable: isTransientError(err),
                timing,
                verification: {
                  attempted: true,
                  ok: false,
                  level: "none",
                  method: "none",
                  reason: "gateway_internal_error",
                  targets: params.target.entity_id ? [params.target.entity_id] : [],
                  before: null,
                  after: null,
                  evidence: { stage: stage.value },
                },
              },
              null,
              2,
            ),
          );
        }
      },
    },
    { optional: true },
  );

  registerTool(
      {
        name: "ha_list_areas",
        description: "List Home Assistant areas via the registry (WS).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const res = await wsCall("config/area_registry/list");

            await traceToolCall({
              tool: "ha_list_areas",
              durationMs: Date.now() - started,
              ok: res.success,
              endpoint: "config/area_registry/list",
              resultBytes: res.bytes,
            });

            if (!res.success || !Array.isArray(res.result)) {
              return textResult(`HA list_areas error: ${JSON.stringify(res.error ?? "")}`);
            }

            const areas = (res.result as Array<Record<string, unknown>>).map((area) => ({
              area_id: String(area["area_id"] ?? ""),
              name: String(area["name"] ?? ""),
            }));

            return textResult(JSON.stringify(areas, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_areas",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "config/area_registry/list",
              error: err,
            });
            return textResult(`HA list_areas error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_list_devices",
        description: "List Home Assistant devices via the registry (WS).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const res = await wsCall("config/device_registry/list");

            await traceToolCall({
              tool: "ha_list_devices",
              durationMs: Date.now() - started,
              ok: res.success,
              endpoint: "config/device_registry/list",
              resultBytes: res.bytes,
            });

            if (!res.success || !Array.isArray(res.result)) {
              return textResult(`HA list_devices error: ${JSON.stringify(res.error ?? "")}`);
            }

            const devices = (res.result as Array<Record<string, unknown>>).map((device) => ({
              device_id: String(device["id"] ?? device["device_id"] ?? ""),
              name: String(device["name_by_user"] ?? device["name"] ?? ""),
              area_id: String(device["area_id"] ?? ""),
              model: String(device["model"] ?? ""),
              manufacturer: String(device["manufacturer"] ?? ""),
            }));

            return textResult(JSON.stringify(devices, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_devices",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "config/device_registry/list",
              error: err,
            });
            return textResult(`HA list_devices error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_list_entity_registry",
        description: "List Home Assistant entity registry entries (WS).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const [res, statesRes] = await Promise.all([
              wsCall("config/entity_registry/list"),
              fetchStates(),
            ]);

            await traceToolCall({
              tool: "ha_list_entity_registry",
              durationMs: Date.now() - started,
              ok: res.success,
              endpoint: "config/entity_registry/list",
              resultBytes: res.bytes,
            });

            if (!res.success || !Array.isArray(res.result)) {
              return textResult(`HA list_entity_registry error: ${JSON.stringify(res.error ?? "")}`);
            }

            const statesById = statesRes.ok && Array.isArray(statesRes.data)
              ? buildStatesById(statesRes.data as HaState[])
              : new Map<string, HaState>();
            const resolveFriendly = (entityId: string) =>
              safeString(statesById.get(entityId)?.attributes?.["friendly_name"]);

            const entities = (res.result as Array<Record<string, unknown>>).map((entity) => ({
              entity_id: String(entity["entity_id"] ?? ""),
              unique_id: String(entity["unique_id"] ?? ""),
              platform: String(entity["platform"] ?? ""),
              area_id: String(entity["area_id"] ?? ""),
              device_id: String(entity["device_id"] ?? ""),
              name: String(entity["name"] ?? entity["original_name"] ?? ""),
              friendly_name: resolveFriendly(String(entity["entity_id"] ?? "")),
              disabled_by: String(entity["disabled_by"] ?? "") || null,
            }));

            return textResult(JSON.stringify(entities, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_entity_registry",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "config/entity_registry/list",
              error: err,
            });
            return textResult(`HA list_entity_registry error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
    {
      name: "ha_registry_snapshot",
      description:
        "DIAGNOSTIC ONLY: return a combined snapshot of areas, devices, and entity registry (WS).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const snapshot = await buildRegistrySnapshot();
            const resultBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");

            await traceToolCall({
              tool: "ha_registry_snapshot",
              durationMs: Date.now() - started,
              ok: true,
              endpoint: "registry_snapshot",
              resultBytes,
            });

            return textResult(
              JSON.stringify(
                {
                  diagnostic_only: true,
                  warning: "Large payload. Use ha_list_area_lights for normal queries.",
                  areas: snapshot.areas,
                  devices: snapshot.devices,
                  entities: snapshot.entities,
                  services_summary: snapshot.services_summary,
                  indexes: snapshot.indexes,
                  ambiguity_report: snapshot.ambiguity_report,
                  assistant_reply:
                    "Dijagnostički snapshot je spreman (velik payload). Za normalna pitanja koristi ha_list_area_lights.",
                  assistant_reply_short:
                    "Dijagnostički snapshot je spreman (velik payload). Za normalna pitanja koristi ha_list_area_lights.",
                },
                null,
                2,
              ),
            );
          } catch (err) {
            await traceToolCall({
              tool: "ha_registry_snapshot",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "registry_snapshot",
              error: err,
            });
            return textResult(`HA registry_snapshot error: ${String(err)}`);
          }
        },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_build_semantic_map",
      description: "Build a semantic map from registry snapshot + states.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          snapshot: { type: "object", additionalProperties: true },
          states: { type: "array", items: { type: "object" } },
        },
        required: ["snapshot", "states"],
      },
      async execute(
        _id: string,
        params: {
          snapshot: { areas: RegistryArea[]; devices: RegistryDevice[]; entities: RegistryEntity[] };
          states: HaState[];
        },
      ) {
        const started = Date.now();
        try {
          const candidates = buildSemanticCandidates(params.snapshot, params.states);
          const map: Record<string, SemanticCandidate[]> = {};
          for (const candidate of candidates) {
            const humanName = candidate.friendly_name || candidate.entity_id;
            map[humanName] = map[humanName] ?? [];
            map[humanName].push(candidate);
          }
          await traceToolCall({
            tool: "ha_build_semantic_map",
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "semantic_map",
            resultBytes: Buffer.byteLength(JSON.stringify(map), "utf8"),
          });
          return textResult(JSON.stringify(map, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_build_semantic_map",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "semantic_map",
            error: err,
          });
          return textResult(`HA build_semantic_map error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_resolve_target",
      description: "Resolve a human query to Home Assistant target candidates.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          area_hint: { type: "string" },
          domain_hint: { type: "string" },
        },
        required: ["query"],
      },
      async execute(
        _id: string,
        params: { query: string; area_hint?: string; domain_hint?: string },
      ) {
        const started = Date.now();
        try {
          const queryNormalized = normalizeName(params.query);
          const queryTokens = queryNormalized
            .split(" ")
            .map((token) => token.trim())
            .filter(Boolean);
          const stopwords = new Set([
            "upali",
            "upaliti",
            "ugasi",
            "ugasiti",
            "mi",
            "u",
            "na",
            "postotak",
            "posto",
            "svjetline",
            "svjetlost",
            "boju",
            "boja",
            "zelena",
            "zelenu",
            "green",
            "lampu",
            "lampi",
            "svjetlo",
            "svjetla",
            "light",
          ]);
          const wantsColor =
            queryNormalized.includes("zelena") ||
            queryNormalized.includes("zelenu") ||
            queryNormalized.includes("green") ||
            queryNormalized.includes("boja") ||
            queryNormalized.includes("boju");
          const wantsUpper =
            queryNormalized.includes("gore") ||
            queryNormalized.includes("gorn") ||
            queryNormalized.includes("gornja") ||
            queryNormalized.includes("gornju");
          const wantsLower =
            queryNormalized.includes("dolje") ||
            queryNormalized.includes("donj") ||
            queryNormalized.includes("donja") ||
            queryNormalized.includes("donju");
          const intentTokens = queryTokens.filter((token) => !stopwords.has(token));

          const snapshot = await buildRegistrySnapshot();
          const areaNameFromQuery = pickAreaNameFromQuery(snapshot.areas, queryNormalized);
          const areaMatch = params.area_hint?.trim()
            ? findAreaMatch(snapshot.areas, params.area_hint)
            : findAreaMatch(snapshot.areas, areaNameFromQuery ?? "");
          const inferredDomainHint =
            params.domain_hint ??
            (queryNormalized.includes("svjetlo") ||
            queryNormalized.includes("lamp") ||
            queryNormalized.includes("light")
              ? "light"
              : "");
          const areaName = areaMatch.area?.name ?? "";

          const filteredEntities = snapshot.entities.filter((entity) => {
            if (inferredDomainHint && !entity.entity_id.startsWith(`${inferredDomainHint}.`)) {
              return false;
            }
            if (!areaName) return true;
            const devicesById = buildDevicesById(snapshot.devices);
            const areasById = buildAreasById(snapshot.areas);
            const resolvedArea = resolveAreaNameForEntity(entity, devicesById, areasById);
            return normalizeName(resolvedArea) === normalizeName(areaName);
          });

          const statesById = buildStatesById(snapshot.states);
          const candidates = filteredEntities.map((entity) => {
            const friendlyName = resolveFriendlyName(entity, statesById);
            const entityId = entity.entity_id;
            const device = snapshot.devices.find((entry) => entry.id === entity.device_id);
            const area = snapshot.areas.find((entry) => entry.area_id === entity.area_id);
            const deviceArea = device
              ? snapshot.areas.find((entry) => entry.area_id === device.area_id)
              : null;
            const areaNameResolved = area?.name ?? deviceArea?.name ?? "";

            let score = 0;
            const scoreBreakdown: Record<string, number> = {};
            if (areaNameResolved && normalizeName(areaNameResolved) === normalizeName(areaName)) {
              score += 20;
              scoreBreakdown.area_match = 20;
            }
            if (inferredDomainHint && entityId.startsWith(`${inferredDomainHint}.`)) {
              score += 10;
              scoreBreakdown.domain_match = 10;
            }
            for (const token of intentTokens) {
              const normalizedToken = normalizeName(token);
              const tokenVariants = [
                normalizedToken,
                normalizedToken.length > 4 ? normalizedToken.slice(0, normalizedToken.length - 1) : "",
              ].filter(Boolean);
              const friendlyNormalized = normalizeName(friendlyName);
              const entityNormalized = normalizeName(entityId);
              const deviceNormalized = normalizeName(device?.name ?? "");
              if (tokenVariants.some((variant) => friendlyNormalized.includes(variant))) {
                score += 10;
                scoreBreakdown[`friendly:${token}`] = 10;
              } else if (tokenVariants.some((variant) => entityNormalized.includes(variant))) {
                score += 6;
                scoreBreakdown[`entity:${token}`] = 6;
              } else if (tokenVariants.some((variant) => deviceNormalized.includes(variant))) {
                score += 5;
                scoreBreakdown[`device:${token}`] = 5;
              }
            }
            if (wantsUpper || wantsLower) {
              if (wantsUpper && normalizeName(entityId).includes("gore")) {
                score += 8;
                scoreBreakdown.direction_upper = 8;
              }
              if (wantsLower && normalizeName(entityId).includes("dolje")) {
                score += 8;
                scoreBreakdown.direction_lower = 8;
              }
            } else if (normalizeName(friendlyName).includes("stropna")) {
              if (normalizeName(entityId).includes("gore")) {
                score += 2;
                scoreBreakdown.direction_default_upper = 2;
              } else if (normalizeName(entityId).includes("dolje")) {
                score -= 1;
                scoreBreakdown.direction_default_lower = -1;
              }
            }
            if (wantsColor) {
              const state = statesById[entityId];
              const supportedModes = Array.isArray(state?.attributes?.supported_color_modes)
                ? (state?.attributes?.supported_color_modes as string[])
                : [];
              const supportsColor = supportedModes.some((mode) =>
                ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(mode),
              );
              if (supportsColor) {
                score += 12;
                scoreBreakdown.color_capable = 12;
              } else if (supportedModes.length > 0) {
                score -= 4;
                scoreBreakdown.color_unsupported = -4;
              }
            }

            return {
              entity_id: entityId,
              domain: entityId.split(".")[0] ?? "",
              area_name: areaNameResolved,
              device_name: device?.name ?? "",
              friendly_name: friendlyName,
              score,
              score_breakdown: scoreBreakdown,
            } satisfies SemanticCandidate;
          });

          const sorted = candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.entity_id.localeCompare(b.entity_id);
          });
          const best = sorted[0];
          const second = sorted[1];
          const scoreGap = second ? best.score - second.score : best?.score ?? 0;
          const needs_confirmation =
            !best || best.score < 20 || (second && best.score < 40 && scoreGap < 10);
          const suggested_prompt_to_user = needs_confirmation
            ? `I found ${sorted.length} candidates. Which one did you mean? ${sorted
                .slice(0, 5)
                .map((c) => `${c.friendly_name || c.entity_id} (${c.entity_id})`)
                .join(", ")}`
            : "";
          const response =
            sorted.length === 0
              ? {
                  ok: false,
                  error: "entity_not_found",
                  candidates: [],
                  area_hint: areaName || params.area_hint || null,
                  domain_hint: inferredDomainHint || null,
                  suggestions: snapshot.entities
                    .filter((entity) => entity.entity_id.startsWith(`${inferredDomainHint || "light"}.`))
                    .slice(0, 5)
                    .map((entity) => ({
                      entity_id: entity.entity_id,
                      friendly_name: resolveFriendlyName(entity, statesById),
                    })),
                }
              : {
                  ok: true,
                  candidates: sorted,
                  best: best ?? null,
                  needs_confirmation,
                  suggested_prompt_to_user,
                };

          await traceToolCall({
            tool: "ha_resolve_target",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "resolve_target",
            resultBytes: Buffer.byteLength(JSON.stringify(sorted), "utf8"),
          });

          return textResult(
            JSON.stringify(
              response,
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_resolve_target",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "resolve_target",
            error: err,
          });
          return textResult(`HA resolve_target error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_entity_capabilities",
      description: "Return derived capabilities for a Home Assistant entity.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
        },
        required: ["entity_id"],
      },
      async execute(_id: string, params: { entity_id: string }) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/states/${encodeURIComponent(params.entity_id)}`,
            token,
          });
          await traceToolCall({
            tool: "ha_entity_capabilities",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: `/api/states/${params.entity_id}`,
            resultBytes: res.bytes,
          });
          if (!res.ok) {
            return textResult(`HA entity_capabilities error: ${res.status}`);
          }
          const state = res.data as HaState;
          return textResult(JSON.stringify(describeCapability(params.entity_id, state), null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_entity_capabilities",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/states/${params.entity_id}`,
            error: err,
          });
          return textResult(`HA entity_capabilities error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_validate_config",
      description: "Validate Home Assistant configuration (WS).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const res = await wsCall("config/core/check_config");

            await traceToolCall({
              tool: "ha_validate_config",
              durationMs: Date.now() - started,
              ok: res.success,
              endpoint: "config/core/check_config",
              resultBytes: res.bytes,
            });

            if (!res.success) {
              return textResult("HA validate_config error");
            }

            return textResult(JSON.stringify(res.result, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_validate_config",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "config/core/check_config",
              error: err,
            });
            return textResult(`HA validate_config error: ${String(err)}`);
          }
        },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_prepare_risky_action",
      description: "Prepare a risky HA action and return a confirmation token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          action: { type: "object", additionalProperties: true },
          reason: { type: "string" },
          domain: { type: "string" },
          service: { type: "string" },
          target: { type: "object", additionalProperties: true },
          data: { type: "object", additionalProperties: true },
          service_data: { type: "object", additionalProperties: true },
          entity_id: { type: "array", items: { type: "string" } },
        },
        required: ["kind"],
      },
      async execute(
        _id: string,
        params: {
          kind: "service_call" | "ha_call_service" | "config_patch" | "automation_config" | "semantic_override";
          action?: Record<string, unknown>;
          reason?: string;
          domain?: string;
          service?: string;
          target?: Record<string, unknown>;
          data?: Record<string, unknown>;
          service_data?: Record<string, unknown>;
          entity_id?: string[];
        },
      ) {
        const started = Date.now();
        try {
          prunePendingActions();
          const actionFromFlat =
            !params.action && (params.domain || params.service || params.target || params.data || params.service_data)
              ? {
                  domain: params.domain,
                  service: params.service,
                  target: params.target,
                  data: params.data ?? params.service_data ?? {},
                  entity_id: params.entity_id,
                }
              : null;
          const resolvedAction = params.action ?? actionFromFlat;
          if (!resolvedAction) {
            return textResult(
              JSON.stringify(
                {
                  ok: false,
                  error: "missing_action",
                  expected: {
                    kind: params.kind,
                    action: {
                      domain: "string",
                      service: "string",
                      data: { entity_id: ["entity.id"] },
                    },
                  },
                },
                null,
                2,
              ),
            );
          }
          let summary = "";
          if (params.kind === "service_call" || params.kind === "ha_call_service") {
            const normalized = normalizeServiceCallAction(resolvedAction);
            const entityIds = toArray(normalized.data["entity_id"] as string | string[] | undefined);
            const decision = getPolicyDecision({
              domain: normalized.domain,
              service: normalized.service,
              entityIds,
            });
            if (decision.action === "deny") {
              return textResult(`HA prepare denied (${decision.reason}).`);
            }
            summary = `service_call ${normalized.domain}.${normalized.service} on ${entityIds.join(", ") || "target"}`;
          } else if (params.kind === "semantic_override") {
            const scope = String(resolvedAction["scope"] ?? "");
            const id = String(resolvedAction["id"] ?? "");
            if (!id || (scope !== "entity" && scope !== "device")) {
              return textResult("HA prepare error: semantic_override requires scope + id");
            }
            summary = `semantic_override ${scope}:${id}`;
          } else if (params.kind === "config_patch") {
            summary = `config_patch ${String(resolvedAction["file"] ?? "")}`;
          } else if (params.kind === "automation_config") {
            const mode = String(resolvedAction["mode"] ?? "");
            const automationId = String(
              resolvedAction["automation_id"] ?? resolvedAction["config"]?.["id"] ?? "",
            );
            if (!automationId || (mode !== "upsert" && mode !== "delete")) {
              return textResult("HA prepare error: automation_config requires mode + id");
            }
            summary = `automation_${mode} ${automationId}`;
          } else {
            return textResult("HA prepare error: unsupported kind");
          }

          const token = randomUUID();
          const record: PendingActionRecord = {
            token,
            createdAt: Date.now(),
            expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
            summary,
            payload:
              params.kind === "service_call" || params.kind === "ha_call_service"
                ? {
                    kind: "service_call",
                    action: normalizeServiceCallAction(resolvedAction),
                  }
                : params.kind === "semantic_override"
                  ? {
                      kind: "semantic_override",
                      action: {
                        scope: String(resolvedAction["scope"] ?? "") as "entity" | "device",
                        id: String(resolvedAction["id"] ?? ""),
                        semantic_type: String(resolvedAction["semantic_type"] ?? "") || undefined,
                        control_model: String(resolvedAction["control_model"] ?? "") || undefined,
                        smoke_test_safe: Boolean(resolvedAction["smoke_test_safe"] ?? false),
                        notes: String(resolvedAction["notes"] ?? "") || undefined,
                      },
                    }
                : params.kind === "automation_config"
                  ? {
                      kind: "automation_config",
                      action: {
                        mode: String(resolvedAction["mode"] ?? "") as "upsert" | "delete",
                        config: (resolvedAction["config"] ?? {}) as Record<string, unknown>,
                        automation_id: String(
                          resolvedAction["automation_id"] ?? resolvedAction["config"]?.["id"] ?? "",
                        ),
                        reload: Boolean(resolvedAction["reload"] ?? false),
                      },
                    }
                  : {
                      kind: "config_patch",
                      action: {
                        file: String(resolvedAction["file"] ?? ""),
                        before: String(resolvedAction["before"] ?? ""),
                        after: String(resolvedAction["after"] ?? ""),
                        validate: Boolean(resolvedAction["validate"] ?? true),
                        reload_domain: String(resolvedAction["reload_domain"] ?? ""),
                      },
                    },
          };
          pendingActions.set(token, record);

          await traceToolCall({
            tool: "ha_prepare_risky_action",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: params.kind,
          });

          return textResult(
            JSON.stringify(
              {
                token,
                confirm_token: token,
                summary,
                expires_at: new Date(record.expiresAt).toISOString(),
                reason: params.reason ?? null,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_prepare_risky_action",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: params.kind,
            error: err,
          });
          return textResult(`HA prepare error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_confirm_action",
      description: "Confirm and execute a previously prepared HA action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          token: { type: "string" },
          confirm_token: { type: "string" },
        },
        required: [],
      },
      async execute(_id: string, params: { token?: string; confirm_token?: string }) {
        const started = Date.now();
        try {
          prunePendingActions();
          const token = params.token ?? params.confirm_token ?? "";
          if (!token) {
            return textResult("HA confirm error: token required");
          }
          const record = pendingActions.get(token);
          if (!record) {
            return textResult("HA confirm error: token not found or expired");
          }
          if (record.expiresAt <= Date.now()) {
            pendingActions.delete(token);
            return textResult("HA confirm error: token expired");
          }
          let result: unknown = null;
          if (record.payload.kind === "service_call") {
            const { domain, service: rawService, data: rawData } = record.payload.action;
            const baseEntityIds = toArray(rawData["entity_id"] as string | string[] | undefined).filter(Boolean);
            const normalized = await normalizeFriendlyServiceCall({
              domain,
              service: rawService,
              payload: rawData,
              entityIds: baseEntityIds,
            });
            const service = normalized.service;
            const data = normalized.payload;
            const entityIds = toArray(data["entity_id"] as string | string[] | undefined).filter(Boolean);
            const normalizationFallback = normalized.fallback ?? null;
            let verification: VerificationResult = buildEmptyVerification("not_verifiable", entityIds);
            let res: { ok: boolean; status?: number; data?: unknown; bytes: number };
            if (domain === "persistent_notification" && service === "create") {
              const notificationId = safeString(data["notification_id"]);
              const wsTrace = await wsTraceServiceCommand({
                entityIds: [],
                domain,
                service,
                data,
                durationMs: 5000,
              });
              res = {
                ok: wsTrace.ok,
                status: wsTrace.ok ? 200 : undefined,
                data: wsTrace.service_result,
                bytes: Buffer.byteLength(JSON.stringify(wsTrace.service_result ?? {}), "utf8"),
              };
              const matchingEvent = wsTrace.events.find((entry) => {
                const payload = entry["data"] as Record<string, unknown>;
                const eventDomain = safeString(payload?.["domain"]);
                const eventService = safeString(payload?.["service"]);
                if (eventDomain !== "persistent_notification" || eventService !== "create") return false;
                if (!notificationId) return true;
                const serviceData = payload?.["service_data"] as Record<string, unknown> | undefined;
                return safeString(serviceData?.["notification_id"]) === notificationId;
              });
              verification = {
                attempted: true,
                ok: Boolean(matchingEvent),
                level: matchingEvent ? "ha_event" : "none",
                method: "ws_event",
                reason: matchingEvent ? "verified" : "timeout",
                targets: [],
                before: null,
                after: null,
                evidence: matchingEvent
                  ? {
                      event_type: safeString(matchingEvent["event_type"]),
                      time_fired: safeString(matchingEvent["time_fired"]),
                      domain: safeString(
                        (matchingEvent["data"] as Record<string, unknown> | undefined)?.["domain"],
                      ),
                      service: safeString(
                        (matchingEvent["data"] as Record<string, unknown> | undefined)?.["service"],
                      ),
                      notification_id: safeString(
                        ((matchingEvent["data"] as Record<string, unknown> | undefined)?.["service_data"] as
                          | Record<string, unknown>
                          | undefined)?.["notification_id"],
                      ),
                    }
                  : null,
              };
            } else {
              const trace = await wsTraceServiceCommand({
                entityIds,
                domain,
                service,
                data,
                durationMs: 8000,
              });
              res = {
                ok: trace.ok,
                status: trace.ok ? 200 : undefined,
                data: trace.service_result,
                bytes: Buffer.byteLength(JSON.stringify(trace.service_result ?? {}), "utf8"),
              };
              if (res.ok) {
                if (entityIds.length > 0) {
                  if (domain === "media_player") {
                    verification = await verifyMediaPlayerChange({ service, payload: data, entityIds });
                  } else if (domain === "climate") {
                    verification = await verifyClimateChange({ service, payload: data, entityIds });
                  } else if (domain === "cover") {
                    verification = await verifyCoverChange({ service, payload: data, entityIds });
                  } else if (domain === "fan") {
                    verification = await verifyFanChange({ service, payload: data, entityIds });
                  } else {
                    verification = await pollForStateVerification({
                      domain,
                      service,
                      payload: data,
                      entityIds,
                      timeoutMs: 5000,
                      intervalMs: 400,
                    });
                  }
                }
              }
              if (verification.attempted) {
                const callEvent = trace.call_event as Record<string, unknown> | null;
                verification = {
                  ...verification,
                  level: verification.ok ? "state" : callEvent ? "ha_event" : "none",
                  evidence: {
                    ...(verification.evidence ?? {}),
                    ws_call_service: callEvent ?? null,
                    ws_state_events: trace.states_during ?? [],
                    applied_fallbacks: buildAppliedFallbacks([], normalizationFallback),
                  },
                };
              }
            }
            if (normalizationFallback && verification.attempted) {
              verification = {
                ...verification,
                ok: false,
                reason: "fallback_applied",
                evidence: { ...(verification.evidence ?? {}), fallback: normalizationFallback },
              };
            }
            if (normalizationFallback && verification.attempted) {
              verification = {
                ...verification,
                ok: false,
                reason: "fallback_applied",
                level: verification.level ?? "none",
                evidence: { ...(verification.evidence ?? {}), fallback: normalizationFallback },
              };
            }
            if (!res.ok) {
              return textResult(`HA confirm error: ${res.status}`);
            }
            if (verification.ok && entityIds.length > 0) {
              await Promise.all(
                entityIds.map((entityId) =>
                  recordRiskApproval({ entityId, actionKind: `${domain}.${service}`, note: "confirmed_action" }),
                ),
              );
            }
            result = {
              status: "ok",
              service: `${domain}.${service}`,
              verification,
            };
          } else if (record.payload.kind === "semantic_override") {
            const overrides = await loadSemanticOverrides();
            const entry: SemanticOverrideEntry = {
              semantic_type: record.payload.action.semantic_type,
              control_model: record.payload.action.control_model,
              smoke_test_safe: record.payload.action.smoke_test_safe,
              notes: record.payload.action.notes,
              ts: new Date().toISOString(),
            };
            if (record.payload.action.scope === "entity") {
              overrides.entity_overrides[record.payload.action.id] = {
                ...overrides.entity_overrides[record.payload.action.id],
                ...entry,
              };
            } else {
              overrides.device_overrides[record.payload.action.id] = {
                ...overrides.device_overrides[record.payload.action.id],
                ...entry,
              };
            }
            await saveSemanticOverrides(overrides);
            result = {
              status: "ok",
              kind: "semantic_override",
              scope: record.payload.action.scope,
              id: record.payload.action.id,
              entry,
              path: SEMANTIC_OVERRIDES_PATH,
            };
          } else if (record.payload.kind === "config_patch") {
            const outcome = await applyConfigPatch(record.payload.action);
            result = { status: "ok", snapshot: outcome.snapshot };
          } else if (record.payload.kind === "automation_config") {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            if (record.payload.action.mode === "delete") {
              const res = await requestJson({
                method: "DELETE",
                url: `${baseUrl}/api/config/automation/config/${encodeURIComponent(
                  record.payload.action.automation_id ?? "",
                )}`,
                token,
              });
              if (!res.ok) {
                return textResult(`HA confirm error: ${res.status}`);
              }
            } else {
              const id = record.payload.action.automation_id ?? "";
              if (!id) {
                return textResult("HA confirm error: automation id missing");
              }
              const res = await requestJson({
                method: "POST",
                url: `${baseUrl}/api/config/automation/config/${encodeURIComponent(id)}`,
                token,
                body: record.payload.action.config ?? {},
              });
              if (!res.ok) {
                return textResult(`HA confirm error: ${res.status}`);
              }
              if (record.payload.action.reload) {
                await requestJson({
                  method: "POST",
                  url: `${baseUrl}/api/services/automation/reload`,
                  token,
                  body: {},
                });
              }
            }
            result = { status: "ok", mode: record.payload.action.mode };
          }
          pendingActions.delete(params.token);

          await traceToolCall({
            tool: "ha_confirm_action",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: record.payload.kind,
          });

          return textResult(JSON.stringify(result, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_confirm_action",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "confirm_action",
            error: err,
          });
          return textResult(`HA confirm error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_cancel_action",
      description: "Cancel a previously prepared HA action token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          token: { type: "string" },
        },
        required: ["token"],
      },
      async execute(_id: string, params: { token: string }) {
        const started = Date.now();
        try {
          prunePendingActions();
          const existed = pendingActions.delete(params.token);
          await traceToolCall({
            tool: "ha_cancel_action",
            params,
            durationMs: Date.now() - started,
            ok: existed,
            endpoint: "cancel_action",
          });
          return textResult(existed ? "ok" : "not_found");
        } catch (err) {
          await traceToolCall({
            tool: "ha_cancel_action",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "cancel_action",
            error: err,
          });
          return textResult(`HA cancel error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_reload_domain",
      description: "Reload a Home Assistant domain (calls /api/services/<domain>/reload).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            domain: { type: "string" },
          },
          required: ["domain"],
        },
      async execute(_id: string, params: { domain: string }) {
        const started = Date.now();
        try {
          const decision = getPolicyDecision({ domain: params.domain, service: "reload" });
          if (decision.action === "confirm_required") {
            return textResult(
              "HA reload_domain requires confirmation. Use ha_prepare_risky_action + ha_confirm_action.",
            );
          }
          if (decision.action === "deny") {
            return textResult(`HA reload_domain denied (${decision.reason}).`);
          }
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const domain = normalizeName(params.domain).replace(/\s+/g, "_");
            const res = await requestJson({
              method: "POST",
              url: `${baseUrl}/api/services/${encodeURIComponent(domain)}/reload`,
              token,
              body: {},
            });

            await traceToolCall({
              tool: "ha_reload_domain",
              params,
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: `/api/services/${domain}/reload`,
              resultBytes: res.bytes,
            });

            if (!res.ok) {
              return textResult(`HA reload_domain error: ${res.status}`);
            }

            return textResult(JSON.stringify(res.data, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_reload_domain",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "reload_domain",
              error: err,
            });
            return textResult(`HA reload_domain error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_get_error_log",
        description: "Fetch Home Assistant error log.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const url = `${baseUrl}/api/error_log`;
            const res = await requestText({
              method: "GET",
              url,
              token,
            });
            const fetchedAt = new Date();
            const tz = await getHaTimeZone();

            await traceToolCall({
              tool: "ha_get_error_log",
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/error_log",
              resultBytes: res.bytes,
            });

            const lines = res.text.split(/\r?\n/).filter(Boolean);
            const responseBase = {
              status: res.status,
              url,
              fetched_at: {
                utc: fetchedAt.toISOString(),
                local: formatLocalTimeSafe(fetchedAt, tz),
                tz,
              },
            };

            if (!res.ok) {
              if (res.status === 404) {
                let wsOutcome: { ok: boolean; data?: unknown; error?: unknown } = { ok: false };
                try {
                  const wsRes = await wsCall("system_log/list");
                  if (wsRes.success) {
                    wsOutcome = { ok: true, data: wsRes.result };
                  } else {
                    wsOutcome = { ok: false, error: wsRes.error };
                  }
                } catch (err) {
                  wsOutcome = { ok: false, error: err };
                }

                if (wsOutcome.ok) {
                  return textResult(
                    JSON.stringify(
                      {
                        ok: true,
                        source: "ws",
                        ...responseBase,
                        tried: ["/api/error_log", "ws:system_log/list"],
                        entries: wsOutcome.data,
                      },
                      null,
                      2,
                    ),
                  );
                }

                return textResult(
                  JSON.stringify(
                    {
                      ok: false,
                      reason: "endpoint_missing",
                      ...responseBase,
                      tried: ["/api/error_log", "ws:system_log/list"],
                      ws_error: sanitizeError(wsOutcome.error),
                      body: res.text.slice(0, 2000),
                    },
                    null,
                    2,
                  ),
                );
              }

              return textResult(
                JSON.stringify(
                  {
                    ok: false,
                    reason: "http_error",
                    ...responseBase,
                    body: res.text.slice(0, 2000),
                  },
                  null,
                  2,
                ),
              );
            }

            return textResult(
              JSON.stringify(
                {
                  ok: true,
                  source: "rest",
                  ...responseBase,
                  lines: lines.slice(-200),
                  raw_text_sample: res.text.slice(0, 2000),
                },
                null,
                2,
              ),
            );
          } catch (err) {
            await traceToolCall({
              tool: "ha_get_error_log",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/error_log",
              error: err,
            });
            return textResult(`HA get_error_log error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_logbook_since",
        description: "Fetch Home Assistant logbook entries since a start time.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          minutes: { type: "number" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          entity_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      async execute(
        _id: string,
        params: { minutes?: number; start_time?: string; end_time?: string; entity_id?: string; limit?: number },
      ) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const timeContext = await buildTimeContext({
            minutes: params.minutes,
            start_time: params.start_time,
            end_time: params.end_time,
          });
          const startTime = timeContext.range_utc.start;
          const endTime = timeContext.range_utc.end;
          const query = new URLSearchParams({ end_time: endTime });
          if (params.entity_id) query.set("entity", params.entity_id);
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/logbook/${encodeURIComponent(startTime)}?${query.toString()}`,
            token,
          });

          await traceToolCall({
            tool: "ha_logbook_since",
            params: {
              ...params,
              time_context: { tz: timeContext.tz, now_utc: timeContext.now_utc },
            },
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/logbook",
            resultBytes: res.bytes,
          });

          if (!res.ok || !Array.isArray(res.data)) {
            return textResult(`HA logbook_since error: ${res.status}`);
          }
          const tz = timeContext.tz;
          const startMs = timeContext.start_date.getTime();
          const endMs = timeContext.end_date.getTime();
          let droppedOut = 0;
          let droppedInvalid = 0;
          const filtered = (res.data as Record<string, unknown>[]).filter((entry) => {
            const when = parseDateValue(String(entry.when ?? ""));
            if (!when) {
              droppedInvalid += 1;
              return false;
            }
            const ts = when.getTime();
            if (ts < startMs || ts > endMs) {
              droppedOut += 1;
              return false;
            }
            return true;
          });

          const limit = params.limit && params.limit > 0 ? params.limit : undefined;
          const trimmed = limit ? filtered.slice(0, limit) : filtered;
          const enriched = trimmed.map((entry) => {
            const when = parseDateValue(String(entry.when ?? ""));
            return {
              ...entry,
              when_local: when ? formatLocalTimeSafe(when, tz) : null,
              when_utc: when ? when.toISOString() : null,
            };
          });
          const warning =
            droppedOut > 0 || droppedInvalid > 0
              ? `Dropped ${droppedOut} out-of-window + ${droppedInvalid} invalid timestamp entries`
              : null;

          return textResult(
            JSON.stringify(
              {
                range_utc: timeContext.range_utc,
                range_local: timeContext.range_local,
                tz,
                now_utc: timeContext.now_utc,
                now_local: timeContext.now_local,
                count_raw: (res.data as Record<string, unknown>[]).length,
                count_in_window: enriched.length,
                count_dropped_out_of_window: droppedOut,
                count_dropped_invalid_timestamp: droppedInvalid,
                warning,
                entries_raw: res.data,
                entries: enriched,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_logbook_since",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/logbook",
            error: err,
          });
          return textResult(`HA logbook_since error: ${String(err)}`);
        }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_history_since",
        description: "Fetch Home Assistant history since a start time.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          minutes: { type: "number" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          entity_id: { type: "string" },
          entity_ids: { type: "array", items: { type: "string" } },
        },
      },
      async execute(
        _id: string,
        params: {
          minutes?: number;
          start_time?: string;
          end_time?: string;
          entity_id?: string;
          entity_ids?: string[];
        },
      ) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const query = new URLSearchParams();
          const entityIds = [...toArray(params.entity_id), ...toArray(params.entity_ids)].filter(Boolean);
          if (entityIds.length > 0) query.set("filter_entity_id", entityIds.join(","));
          const timeContext = await buildTimeContext({
            minutes: params.minutes,
            start_time: params.start_time,
            end_time: params.end_time,
          });
          query.set("end_time", timeContext.range_utc.end);
          query.set("minimal_response", "1");
          const startTime = timeContext.range_utc.start;
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/history/period/${encodeURIComponent(startTime)}?${query.toString()}`,
            token,
          });

            await traceToolCall({
              tool: "ha_history_since",
              params: {
                ...params,
                time_context: { tz: timeContext.tz, now_utc: timeContext.now_utc },
              },
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/history/period",
              resultBytes: res.bytes,
            });

            if (!res.ok) {
              return textResult(`HA history_since error: ${res.status}`);
            }
            const startMs = timeContext.start_date.getTime();
            const endMs = timeContext.end_date.getTime();
            let rawCount = 0;
            let keptCount = 0;
            let droppedOut = 0;
            let droppedInvalid = 0;
            const buckets = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>[]>) : [];
            const filtered = buckets.map((bucket) => {
              if (!Array.isArray(bucket)) return [];
              return bucket
                .map((entry) => {
                  rawCount += 1;
                  const lastChanged = parseDateValue(String(entry["last_changed"] ?? ""));
                  if (!lastChanged) {
                    droppedInvalid += 1;
                    return null;
                  }
                  const ts = lastChanged.getTime();
                  if (ts < startMs || ts > endMs) {
                    droppedOut += 1;
                    return null;
                  }
                  keptCount += 1;
                  return {
                    ...entry,
                    last_changed_utc: lastChanged.toISOString(),
                    last_changed_local: formatLocalTimeSafe(lastChanged, timeContext.tz),
                  };
                })
                .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            });

            const warning =
              droppedOut > 0 || droppedInvalid > 0
                ? `Dropped ${droppedOut} out-of-window + ${droppedInvalid} invalid timestamp entries`
                : null;

            return textResult(
              JSON.stringify(
                {
                  range_utc: timeContext.range_utc,
                  range_local: timeContext.range_local,
                  tz: timeContext.tz,
                  now_utc: timeContext.now_utc,
                  now_local: timeContext.now_local,
                  count_raw: rawCount,
                  count_in_window: keptCount,
                  count_dropped_out_of_window: droppedOut,
                  count_dropped_invalid_timestamp: droppedInvalid,
                  warning,
                  buckets: filtered,
                },
                null,
                2,
              ),
            );
          } catch (err) {
            await traceToolCall({
              tool: "ha_history_since",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/history/period",
              error: err,
            });
            return textResult(`HA history_since error: ${String(err)}`);
          }
        },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_incident_timeline",
      description: "Build an incident timeline from logbook, history, and tool traces.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          minutes: { type: "number" },
          area_name: { type: "string" },
          entity_ids: { type: "array", items: { type: "string" } },
        },
        required: ["minutes"],
      },
      async execute(
        _id: string,
        params: { minutes: number; area_name?: string; entity_ids?: string[] },
      ) {
        const started = Date.now();
        try {
          const snapshot = await buildRegistrySnapshot();
          const targetEntityIds = new Set<string>(params.entity_ids ?? []);
          if (params.area_name) {
            const areaEntry = snapshot.indexes.by_area_name[params.area_name];
            if (areaEntry) {
              areaEntry.entity_ids.forEach((id) => targetEntityIds.add(id));
            }
          }
          const entityIdList = Array.from(targetEntityIds);
          const startTime = nowMinusMinutes(params.minutes);

          const logbookRes = await requestJson({
            method: "GET",
            url: `${getHaBaseUrl()}/api/logbook?${new URLSearchParams({ start_time: startTime }).toString()}`,
            token: getHaToken(),
          });
          const historyQuery = new URLSearchParams({
            minimal_response: "1",
          });
          if (entityIdList.length > 0) {
            historyQuery.set("filter_entity_id", entityIdList.join(","));
          }
          const historyRes = await requestJson({
            method: "GET",
            url: `${getHaBaseUrl()}/api/history/period/${encodeURIComponent(startTime)}?${historyQuery.toString()}`,
            token: getHaToken(),
          });

          const logbook = Array.isArray(logbookRes.data) ? logbookRes.data : [];
          const filteredLogbook =
            entityIdList.length === 0
              ? logbook
              : logbook.filter((entry: Record<string, unknown>) =>
                  entityIdList.includes(String(entry["entity_id"] ?? "")),
                );

          const history = historyRes.data ?? [];

          let trace: Array<Record<string, unknown>> = [];
          try {
            const traceText = await readFile(TRACE_PATH, "utf8");
            const lines = traceText.trim().split("\n").slice(-200);
            trace = lines
              .map((line) => {
                try {
                  return JSON.parse(line);
                } catch {
                  return null;
                }
              })
              .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            if (entityIdList.length > 0) {
              trace = trace.filter((entry) =>
                entityIdList.some((entityId) =>
                  JSON.stringify(entry).toLowerCase().includes(entityId.toLowerCase()),
                ),
              );
            }
          } catch {
            trace = [];
          }

          const summary = `Timeline: ${filteredLogbook.length} logbook entries, ${
            Array.isArray(history) ? history.length : 0
          } history buckets, ${trace.length} tool traces.`;

          await traceToolCall({
            tool: "ha_incident_timeline",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "incident_timeline",
          });

          return textResult(
            JSON.stringify(
              {
                start_time: startTime,
                entity_ids: entityIdList,
                logbook: filteredLogbook,
                history,
                trace,
                summary,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_incident_timeline",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "incident_timeline",
            error: err,
          });
          return textResult(`HA incident_timeline error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_why_changed",
      description: "Explain why an entity changed recently (logbook-based attribution).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          minutes_window: { type: "number" },
        },
        required: ["entity_id", "minutes_window"],
      },
      async execute(_id: string, params: { entity_id: string; minutes_window: number }) {
        const started = Date.now();
        try {
          const startTime = nowMinusMinutes(params.minutes_window);
          const query = new URLSearchParams({ start_time: startTime, entity: params.entity_id });
          const res = await requestJson({
            method: "GET",
            url: `${getHaBaseUrl()}/api/logbook?${query.toString()}`,
            token: getHaToken(),
          });
          const entries = Array.isArray(res.data) ? res.data : [];
          const last = entries[0] ?? null;
          const attribution = last
            ? {
                name: last["name"] ?? null,
                message: last["message"] ?? null,
                domain: last["domain"] ?? null,
                service: last["service"] ?? null,
                context_id: last["context_id"] ?? null,
              }
            : null;
          await traceToolCall({
            tool: "ha_why_changed",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "why_changed",
          });
          return textResult(
            JSON.stringify(
              {
                entity_id: params.entity_id,
                start_time: startTime,
                logbook_entries: entries,
                attribution,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_why_changed",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "why_changed",
            error: err,
          });
          return textResult(`HA why_changed error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_list_scenes",
      description: "List Home Assistant scenes.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestJson({
              method: "GET",
              url: `${baseUrl}/api/states`,
              token,
            });

            await traceToolCall({
              tool: "ha_list_scenes",
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/states",
              resultBytes: res.bytes,
            });

            if (!res.ok || !Array.isArray(res.data)) {
              return textResult(`HA list_scenes error: ${res.status}`);
            }

            const scenes = listEntitiesByDomains(res.data as HaState[], ["scene"]);
            return textResult(JSON.stringify(scenes, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_scenes",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/states",
              error: err,
            });
            return textResult(`HA list_scenes error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_activate_scene",
        description: "Activate a Home Assistant scene.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_id: { type: "string" },
          },
          required: ["entity_id"],
        },
        async execute(_id: string, params: { entity_id: string }) {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestJson({
              method: "POST",
              url: `${baseUrl}/api/services/scene/turn_on`,
              token,
              body: { entity_id: params.entity_id },
            });

            await traceToolCall({
              tool: "ha_activate_scene",
              params,
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/services/scene/turn_on",
              resultBytes: res.bytes,
            });

            if (!res.ok) {
              return textResult(`HA activate_scene error: ${res.status}`);
            }

            return textResult(JSON.stringify(res.data, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_activate_scene",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/services/scene/turn_on",
              error: err,
            });
            return textResult(`HA activate_scene error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_list_scripts",
        description: "List Home Assistant scripts.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestJson({
              method: "GET",
              url: `${baseUrl}/api/states`,
              token,
            });

            await traceToolCall({
              tool: "ha_list_scripts",
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/states",
              resultBytes: res.bytes,
            });

            if (!res.ok || !Array.isArray(res.data)) {
              return textResult(`HA list_scripts error: ${res.status}`);
            }

            const scripts = listEntitiesByDomains(res.data as HaState[], ["script"]);
            return textResult(JSON.stringify(scripts, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_scripts",
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/states",
              error: err,
            });
            return textResult(`HA list_scripts error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_run_script",
        description: "Run a Home Assistant script.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_id: { type: "string" },
            data: { type: "object", additionalProperties: true },
          },
          required: ["entity_id"],
        },
        async execute(_id: string, params: { entity_id: string; data?: Record<string, unknown> }) {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestJson({
              method: "POST",
              url: `${baseUrl}/api/services/script/turn_on`,
              token,
              body: params.data ? { entity_id: params.entity_id, ...params.data } : { entity_id: params.entity_id },
            });

            await traceToolCall({
              tool: "ha_run_script",
              params,
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/services/script/turn_on",
              resultBytes: res.bytes,
            });

            if (!res.ok) {
              return textResult(`HA run_script error: ${res.status}`);
            }

            return textResult(JSON.stringify(res.data, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_run_script",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/services/script/turn_on",
              error: err,
            });
            return textResult(`HA run_script error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_list_helpers",
        description: "List Home Assistant helpers (input_* entities).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            domains: { type: "array", items: { type: "string" } },
          },
        },
        async execute(_id: string, params: { domains?: string[] }) {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const res = await requestJson({
              method: "GET",
              url: `${baseUrl}/api/states`,
              token,
            });

            await traceToolCall({
              tool: "ha_list_helpers",
              params,
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: "/api/states",
              resultBytes: res.bytes,
            });

            if (!res.ok || !Array.isArray(res.data)) {
              return textResult(`HA list_helpers error: ${res.status}`);
            }

            const domains = params.domains && params.domains.length > 0 ? params.domains : DEFAULT_HELPER_DOMAINS;
            const helpers = listEntitiesByDomains(res.data as HaState[], domains);
            return textResult(JSON.stringify(helpers, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_list_helpers",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "/api/states",
              error: err,
            });
            return textResult(`HA list_helpers error: ${String(err)}`);
          }
        },
      },
      { optional: true },
    );

    registerTool(
      {
        name: "ha_set_helper",
        description: "Set a Home Assistant helper (input_* entities).",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_id: { type: "string" },
            value: { type: ["string", "number", "boolean"] },
          },
          required: ["entity_id"],
        },
        async execute(
          _id: string,
          params: { entity_id: string; value?: string | number | boolean },
        ) {
          const started = Date.now();
          try {
            const baseUrl = getHaBaseUrl();
            const token = getHaToken();
            const domain = params.entity_id.split(".")[0] ?? "";

            const serviceMap: Record<string, { service: string; data?: Record<string, unknown> }> = {};
            if (domain === "input_boolean") {
              if (params.value === undefined) {
                serviceMap[domain] = { service: "toggle" };
              } else if (params.value === true || params.value === "on") {
                serviceMap[domain] = { service: "turn_on" };
              } else if (params.value === false || params.value === "off") {
                serviceMap[domain] = { service: "turn_off" };
              } else {
                return textResult("HA set_helper error: invalid value for input_boolean");
              }
            } else if (domain === "input_number") {
              if (typeof params.value !== "number") {
                return textResult("HA set_helper error: value must be number for input_number");
              }
              serviceMap[domain] = { service: "set_value", data: { value: params.value } };
            } else if (domain === "input_text") {
              if (typeof params.value !== "string") {
                return textResult("HA set_helper error: value must be string for input_text");
              }
              serviceMap[domain] = { service: "set_value", data: { value: params.value } };
            } else if (domain === "input_select") {
              if (typeof params.value !== "string") {
                return textResult("HA set_helper error: value must be string for input_select");
              }
              serviceMap[domain] = { service: "select_option", data: { option: params.value } };
            } else if (domain === "input_datetime") {
              if (typeof params.value !== "string") {
                return textResult("HA set_helper error: value must be string for input_datetime");
              }
              serviceMap[domain] = { service: "set_datetime", data: { datetime: params.value } };
            } else if (domain === "input_button") {
              serviceMap[domain] = { service: "press" };
            } else {
              return textResult(`HA set_helper error: unsupported domain ${domain}`);
            }

            const service = serviceMap[domain]?.service;
            const data = serviceMap[domain]?.data ?? {};
            const res = await requestJson({
              method: "POST",
              url: `${baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
              token,
              body: { entity_id: params.entity_id, ...data },
            });

            await traceToolCall({
              tool: "ha_set_helper",
              params,
              durationMs: Date.now() - started,
              httpStatus: res.status,
              ok: res.ok,
              endpoint: `/api/services/${domain}/${service}`,
              resultBytes: res.bytes,
            });

            if (!res.ok) {
              return textResult(`HA set_helper error: ${res.status}`);
            }

            return textResult(JSON.stringify(res.data, null, 2));
          } catch (err) {
            await traceToolCall({
              tool: "ha_set_helper",
              params,
              durationMs: Date.now() - started,
              ok: false,
              endpoint: "set_helper",
              error: err,
            });
            return textResult(`HA set_helper error: ${String(err)}`);
          }
        },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_config_intel_list",
      description: "List automations/scripts/helpers from config when accessible; fallback to states.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          kinds: { type: "array", items: { type: "string" } },
        },
      },
      async execute(_id: string, params: { query?: string; kinds?: string[] }) {
        const started = Date.now();
        try {
          const configDir = await resolveConfigDir();
          if (configDir) {
            const items = await loadConfigItems(configDir, params.query, params.kinds);
            await traceToolCall({
              tool: "ha_config_intel_list",
              params,
              durationMs: Date.now() - started,
              ok: true,
              endpoint: "config_intel",
              resultBytes: Buffer.byteLength(JSON.stringify(items), "utf8"),
            });
            return textResult(JSON.stringify({ source: "config", items }, null, 2));
          }

          const statesRes = await fetchStates();
          if (!statesRes.ok) {
            return textResult("HA config_intel error: /api/states unavailable");
          }
          const states = statesRes.data as HaState[];
          const items: ConfigItem[] = [];
          for (const state of states) {
            const domain = state.entity_id.split(".")[0] ?? "";
            if (domain === "automation") {
              items.push({
                kind: "automation",
                id: String(state.attributes?.["id"] ?? ""),
                alias: String(state.attributes?.["friendly_name"] ?? ""),
                entity_id: state.entity_id,
                file: "states",
                trigger: state.attributes?.["last_triggered"] ?? null,
              });
            } else if (domain === "script") {
              items.push({
                kind: "script",
                id: state.entity_id.split(".")[1] ?? "",
                alias: String(state.attributes?.["friendly_name"] ?? ""),
                entity_id: state.entity_id,
                file: "states",
              });
            } else if (DEFAULT_HELPER_DOMAINS.includes(domain)) {
              items.push({
                kind: "helper",
                id: state.entity_id.split(".")[1] ?? "",
                alias: String(state.attributes?.["friendly_name"] ?? ""),
                entity_id: state.entity_id,
                file: "states",
              });
            }
          }
          const filtered = items.filter((item) => matchQuery(item, params.query));
          await traceToolCall({
            tool: "ha_config_intel_list",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "config_intel_fallback",
            resultBytes: Buffer.byteLength(JSON.stringify(filtered), "utf8"),
          });
          return textResult(JSON.stringify({ source: "states", items: filtered }, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_config_intel_list",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "config_intel",
            error: err,
          });
          return textResult(`HA config_intel error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_config_apply_patch",
      description: "Apply a minimal config patch with validation and optional reload (requires confirmation).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          confirm_token: { type: "string" },
          file: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          validate: { type: "boolean" },
          reload_domain: { type: "string" },
        },
        required: ["confirm_token", "file", "before", "after"],
      },
      async execute(
        _id: string,
        params: {
          confirm_token: string;
          file: string;
          before: string;
          after: string;
          validate?: boolean;
          reload_domain?: string;
        },
      ) {
        const started = Date.now();
        try {
          prunePendingActions();
          const record = pendingActions.get(params.confirm_token);
          if (!record || record.payload.kind !== "config_patch") {
            return textResult("HA config_apply_patch error: invalid confirmation token");
          }
          if (record.expiresAt <= Date.now()) {
            pendingActions.delete(params.confirm_token);
            return textResult("HA config_apply_patch error: confirmation token expired");
          }
          const outcome = await applyConfigPatch({
            file: params.file,
            before: params.before,
            after: params.after,
            validate: params.validate,
            reload_domain: params.reload_domain,
          });
          pendingActions.delete(params.confirm_token);
          await traceToolCall({
            tool: "ha_config_apply_patch",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "config_apply_patch",
          });
          return textResult(JSON.stringify({ status: "ok", snapshot: outcome.snapshot }, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_config_apply_patch",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "config_apply_patch",
            error: err,
          });
          return textResult(`HA config_apply_patch error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_plan_action",
      description: "Create a deterministic action plan for a Home Assistant intent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          user_intent: { type: "string" },
          constraints: { type: "object", additionalProperties: true },
        },
        required: ["user_intent"],
      },
      async execute(
        _id: string,
        params: { user_intent: string; constraints?: Record<string, unknown> },
      ) {
        const started = Date.now();
        try {
          const routeMatch = matchInventoryRouteTokens(params.user_intent);
          if (routeMatch.matched.length > 0) {
            const response = {
              route: "inventory_report",
              matched_tokens: routeMatch.matched,
              tools_needed: ["ha_inventory_report"],
              steps: [],
              requires_confirmation: false,
              assistant_reply:
                "Prepoznat zahtjev za inventar/izvještaj. Pokrećem ha_inventory_report.",
              assistant_reply_short: "Pokrećem inventar izvještaj.",
            };
            await traceToolCall({
              tool: "ha_plan_action",
              params,
              durationMs: Date.now() - started,
              ok: true,
              endpoint: "plan_action",
              resultBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
            });
            return textResult(JSON.stringify(response, null, 2));
          }

          const intent = normalizeName(params.user_intent);
          let domainHint = "";
          let service = "";
          if (intent.includes("turn on")) service = "turn_on";
          if (intent.includes("turn off")) service = "turn_off";
          if (intent.includes("toggle")) service = "toggle";
          if (intent.includes("scene")) domainHint = "scene";
          if (intent.includes("script")) domainHint = "script";
          if (intent.includes("light") || intent.includes("lamp")) domainHint = "light";
          if (intent.includes("climate") || intent.includes("heat") || intent.includes("cool")) domainHint = "climate";
          if (!service) service = "turn_on";
          if (!domainHint) domainHint = "light";

          const snapshot = await buildRegistrySnapshot();
          const resolved = buildSemanticCandidates(
            { areas: snapshot.areas, devices: snapshot.devices, entities: snapshot.entities },
            snapshot.states,
          ).map((candidate) => ({
            ...candidate,
            ...scoreCandidateForQuery(candidate, params.user_intent, undefined, domainHint),
          }));

          const best = resolved.sort((a, b) => b.score - a.score)[0];
          const needsConfirmation = !best || best.score < 60;

          const steps = best
            ? [
                {
                  id: "step-1",
                  action: "service_call",
                  domain: best.domain,
                  service,
                  data: { entity_id: [best.entity_id] },
                },
              ]
            : [];

          const decision = getPolicyDecision({
            domain: best?.domain,
            service,
            entityIds: best ? [best.entity_id] : [],
          });

          const plan = {
            steps,
            tools_needed: ["ha_call_service", "ha_dry_run_service_call"],
            entities: best ? [best.entity_id] : [],
            risk_flags: decision.action !== "allow" ? [decision.reason] : [],
            requires_confirmation: decision.action !== "allow" || needsConfirmation,
          };

          await traceToolCall({
            tool: "ha_plan_action",
            params,
            durationMs: Date.now() - started,
            ok: true,
            endpoint: "plan_action",
          });

          return textResult(JSON.stringify(plan, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_plan_action",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "plan_action",
            error: err,
          });
          return textResult(`HA plan_action error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_execute_plan",
      description: "Execute a Home Assistant plan (optionally using confirmation token).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          plan: { type: "object", additionalProperties: true },
          confirm_token: { type: "string" },
        },
        required: ["plan"],
      },
      async execute(
        _id: string,
        params: { plan: Record<string, unknown>; confirm_token?: string },
      ) {
        const started = Date.now();
        try {
          const plan = params.plan as {
            steps?: Array<Record<string, unknown>>;
            requires_confirmation?: boolean;
          };
          if (plan.requires_confirmation) {
            if (!params.confirm_token) {
              return textResult("HA execute_plan error: confirmation required");
            }
            const record = pendingActions.get(params.confirm_token);
            if (!record) {
              return textResult("HA execute_plan error: invalid confirmation token");
            }
            pendingActions.delete(params.confirm_token);
          }
          const steps = plan.steps ?? [];
          const results: Array<Record<string, unknown>> = [];
          let okCount = 0;
          let failCount = 0;
          const failures: Array<Record<string, unknown>> = [];
          for (const step of steps) {
            if (step["action"] !== "service_call") {
              failures.push({ step, error: "unsupported step action" });
              failCount += 1;
              continue;
            }
            const domain = String(step["domain"] ?? "");
            const service = String(step["service"] ?? "");
            const data = (step["data"] ?? {}) as Record<string, unknown>;
            const dryRun = await requestJson({
              method: "POST",
              url: `${getHaBaseUrl()}/api/services/${domain}/${service}`,
              token: getHaToken(),
              body: data,
            });
            if (!dryRun.ok) {
              failures.push({ step, error: `service failed: ${dryRun.status}` });
              failCount += 1;
              continue;
            }
            results.push({ step, status: "ok" });
            okCount += 1;
          }

          await traceToolCall({
            tool: "ha_execute_plan",
            params,
            durationMs: Date.now() - started,
            ok: failCount === 0,
            endpoint: "execute_plan",
          });

          return textResult(
            JSON.stringify(
              {
                step_results: results,
                ok_count: okCount,
                fail_count: failCount,
                failures,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          await traceToolCall({
            tool: "ha_execute_plan",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "execute_plan",
            error: err,
          });
          return textResult(`HA execute_plan error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_list_automations",
      description: "List Home Assistant automations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/states`,
            token,
          });

          await traceToolCall({
            tool: "ha_list_automations",
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: "/api/states",
            resultBytes: res.bytes,
          });

          if (!res.ok || !Array.isArray(res.data)) {
            return textResult(`HA list_automations error: ${res.status}`);
          }

          const automations = (res.data as HaState[])
            .filter((entity) => entity.entity_id.startsWith("automation."))
            .map((entity) => ({
              entity_id: entity.entity_id,
              id: String(entity.attributes?.["id"] ?? ""),
              friendly_name: String(entity.attributes?.["friendly_name"] ?? ""),
              last_triggered: entity.attributes?.["last_triggered"] ?? null,
            }));

          return textResult(JSON.stringify(automations, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_list_automations",
            durationMs: Date.now() - started,
            ok: false,
            endpoint: "/api/states",
            error: err,
          });
          return textResult(`HA list_automations error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_get_automation_config",
      description: "Fetch automation config by automation id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          automation_id: { type: "string" },
        },
        required: ["automation_id"],
      },
      async execute(_id: string, params: { automation_id: string }) {
        const started = Date.now();
        try {
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "GET",
            url: `${baseUrl}/api/config/automation/config/${encodeURIComponent(params.automation_id)}`,
            token,
          });

          await traceToolCall({
            tool: "ha_get_automation_config",
            params,
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: `/api/config/automation/config/${params.automation_id}`,
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(`HA get_automation_config error: ${res.status}`);
          }

          return textResult(JSON.stringify(res.data, null, 2));
        } catch (err) {
          await traceToolCall({
            tool: "ha_get_automation_config",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/config/automation/config/${params.automation_id}`,
            error: err,
          });
          return textResult(`HA get_automation_config error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_upsert_automation_config",
      description: "Create or update automation config (requires config with id).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          confirm_token: { type: "string" },
          config: { type: "object", additionalProperties: true },
          reload: { type: "boolean" },
        },
        required: ["confirm_token"],
      },
      async execute(
        _id: string,
        params: { confirm_token: string; config?: Record<string, unknown>; reload?: boolean },
      ) {
        const started = Date.now();
        try {
          const record = pendingActions.get(params.confirm_token);
          if (!record || record.payload.kind !== "automation_config") {
            return textResult("HA upsert error: confirmation token required");
          }
          if (record.payload.action.mode !== "upsert") {
            return textResult("HA upsert error: token is not for upsert");
          }
          const config = record.payload.action.config ?? params.config ?? {};
          const id = String(record.payload.action.automation_id ?? config["id"] ?? "");
          if (!id) {
            return textResult("HA upsert error: automation id missing");
          }

          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "POST",
            url: `${baseUrl}/api/config/automation/config/${encodeURIComponent(id)}`,
            token,
            body: config,
          });

          await traceToolCall({
            tool: "ha_upsert_automation_config",
            params: { config: { id }, reload: params.reload },
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: `/api/config/automation/config/${id}`,
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(`HA upsert error: ${res.status}`);
          }

          if (params.reload ?? record.payload.action.reload) {
            await requestJson({
              method: "POST",
              url: `${baseUrl}/api/services/automation/reload`,
              token,
              body: {},
            });
          }

          pendingActions.delete(params.confirm_token);
          return textResult("ok");
        } catch (err) {
          await traceToolCall({
            tool: "ha_upsert_automation_config",
            params: { config: { id: params.config?.["id"] }, reload: params.reload },
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/config/automation/config/${params.config?.["id"]}`,
            error: err,
          });
          return textResult(`HA upsert error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );

  registerTool(
    {
      name: "ha_delete_automation",
      description: "Delete automation config by automation id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          confirm_token: { type: "string" },
          automation_id: { type: "string" },
        },
        required: ["confirm_token"],
      },
      async execute(_id: string, params: { confirm_token: string; automation_id?: string }) {
        const started = Date.now();
        try {
          const record = pendingActions.get(params.confirm_token);
          if (!record || record.payload.kind !== "automation_config") {
            return textResult("HA delete automation error: confirmation token required");
          }
          if (record.payload.action.mode !== "delete") {
            return textResult("HA delete automation error: token is not for delete");
          }
          const automationId = record.payload.action.automation_id ?? params.automation_id ?? "";
          if (!automationId) {
            return textResult("HA delete automation error: automation id missing");
          }
          const baseUrl = getHaBaseUrl();
          const token = getHaToken();
          const res = await requestJson({
            method: "DELETE",
            url: `${baseUrl}/api/config/automation/config/${encodeURIComponent(automationId)}`,
            token,
          });

          await traceToolCall({
            tool: "ha_delete_automation",
            params: { automation_id: automationId },
            durationMs: Date.now() - started,
            httpStatus: res.status,
            ok: res.ok,
            endpoint: `/api/config/automation/config/${automationId}`,
            resultBytes: res.bytes,
          });

          if (!res.ok) {
            return textResult(`HA delete automation error: ${res.status}`);
          }

          pendingActions.delete(params.confirm_token);
          return textResult("ok");
        } catch (err) {
          await traceToolCall({
            tool: "ha_delete_automation",
            params,
            durationMs: Date.now() - started,
            ok: false,
            endpoint: `/api/config/automation/config/${params.automation_id ?? ""}`,
            error: err,
          });
          return textResult(`HA delete automation error: ${String(err)}`);
        }
      },
    },
    { optional: true },
  );
};

const plugin = {
  id: "homeassistant",
  name: "Home Assistant",
  description: "Home Assistant tools (HA_URL + HA_TOKEN).",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerTools(api);
  },
};

export default plugin;
