import { Type } from "@sinclair/typebox";
import {
  readStringParam,
  stringEnum,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk";

const MINDSDB_ACTIONS = ["query", "list_databases", "parametrize_constants"] as const;
const READ_ONLY_QUERY_PREFIXES = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "WITH",
  "USE",
]);

const DEFAULT_BASE_URL = "http://127.0.0.1:47334";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_CHARS = 30_000;

const MIN_TIMEOUT_MS = 1_000;
const MIN_ROWS = 1;
const MAX_ROWS = 1_000;
const MIN_CHARS = 1_000;
const MAX_CHARS = 300_000;

type MindsdbAction = (typeof MINDSDB_ACTIONS)[number];

type JsonRecord = Record<string, unknown>;

export type MindsdbPluginConfig = {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  allowMutatingQueries: boolean;
  requestTimeoutMs: number;
  maxRows: number;
  maxChars: number;
};

export type MindsdbToolParams = {
  action: MindsdbAction;
  query?: string;
  params?: JsonRecord;
  context?: JsonRecord;
};

export const MindsdbToolSchema = Type.Object(
  {
    action: stringEnum(MINDSDB_ACTIONS, {
      description: `Action to perform: ${MINDSDB_ACTIONS.join(", ")}`,
    }),
    query: Type.Optional(
      Type.String({
        description:
          "SQL query string. Required for action=query and action=parametrize_constants.",
      }),
    ),
    params: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Optional named query parameters for action=query (maps to MindsDB /api/sql/query params).",
      }),
    ),
    context: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Optional MindsDB SQL context object (for example: { profiling: true }).",
      }),
    ),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(bounds.max, Math.max(bounds.min, parsed));
    }
  }
  return fallback;
}

function readRecordParam(params: Record<string, unknown>, key: string): JsonRecord | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${cleanPath}`;
}

function stripLeadingSqlComments(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .trimStart();
}

export function looksMutatingQuery(query: string): boolean {
  const normalized = stripLeadingSqlComments(query);
  if (!normalized) {
    return false;
  }

  const keywordMatch = normalized.match(/^([A-Za-z_]+)/);
  if (!keywordMatch) {
    return true;
  }

  const prefix = keywordMatch[1]?.toUpperCase() ?? "";
  return !READ_ONLY_QUERY_PREFIXES.has(prefix);
}

function tableRowCount(payload: unknown): number | undefined {
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data.length;
  }
  return undefined;
}

function previewResponse(payload: unknown, maxRows: number): unknown {
  if (!isRecord(payload) || payload.type !== "table" || !Array.isArray(payload.data)) {
    return payload;
  }

  const rows = payload.data;
  const previewRows = rows.slice(0, maxRows);
  return {
    ...payload,
    data: previewRows,
    total_rows: rows.length,
    shown_rows: previewRows.length,
    truncated_rows: Math.max(0, rows.length - previewRows.length),
  };
}

function renderPayload(
  payload: unknown,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
  originalChars: number;
} {
  let serialized = "";

  try {
    serialized = JSON.stringify(payload, null, 2);
  } catch {
    serialized = String(payload);
  }

  const originalChars = serialized.length;
  if (originalChars <= maxChars) {
    return { text: serialized, truncated: false, originalChars };
  }

  const keepChars = Math.max(0, maxChars - 96);
  const remaining = originalChars - keepChars;
  const truncatedText = `${serialized.slice(0, keepChars)}\n... [truncated ${remaining} chars]`;
  return {
    text: truncatedText,
    truncated: true,
    originalChars,
  };
}

function responseType(payload: unknown): string {
  if (isRecord(payload) && typeof payload.type === "string") {
    return payload.type;
  }
  return "unknown";
}

function formatHttpError(status: number, payload: unknown): string {
  if (isRecord(payload)) {
    const errorMessage = readOptionalString(payload.error_message);
    if (errorMessage) {
      return `MindsDB request failed (${status}): ${errorMessage}`;
    }

    const message = readOptionalString(payload.message);
    if (message) {
      return `MindsDB request failed (${status}): ${message}`;
    }
  }

  return `MindsDB request failed with HTTP ${status}`;
}

async function requestJson(params: {
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  authHeader?: string;
  timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    let body: string | undefined;
    if (params.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params.body);
    }

    if (params.authHeader) {
      headers.Authorization = params.authHeader;
    }

    const response = await fetch(buildUrl(params.baseUrl, params.path), {
      method: params.method,
      headers,
      body,
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload: unknown = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { message: raw };
      }
    }

    if (!response.ok) {
      throw new Error(formatHttpError(response.status, payload));
    }

    return payload;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`MindsDB request timed out after ${params.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLoginToken(config: MindsdbPluginConfig): Promise<string> {
  if (!config.username || !config.password) {
    throw new Error("username/password required to request a MindsDB token");
  }

  const response = await requestJson({
    baseUrl: config.baseUrl,
    path: "/api/login",
    method: "POST",
    body: {
      username: config.username,
      password: config.password,
    },
    timeoutMs: config.requestTimeoutMs,
  });

  if (isRecord(response) && typeof response.token === "string" && response.token.trim()) {
    return response.token.trim();
  }

  throw new Error(
    "MindsDB login succeeded but no token was returned. Configure a token directly or enable token auth in MindsDB.",
  );
}

export function resolveMindsdbPluginConfig(raw: unknown): MindsdbPluginConfig {
  const input = isRecord(raw) ? raw : {};

  const baseUrl = normalizeBaseUrl(
    readOptionalString(input.baseUrl) ??
      readOptionalString(process.env.MINDSDB_URL) ??
      readOptionalString(process.env.MINDSDB_API_URL) ??
      DEFAULT_BASE_URL,
  );

  const token = readOptionalString(input.token) ?? readOptionalString(process.env.MINDSDB_TOKEN);
  const username =
    readOptionalString(input.username) ?? readOptionalString(process.env.MINDSDB_USERNAME);
  const password =
    readOptionalString(input.password) ?? readOptionalString(process.env.MINDSDB_PASSWORD);

  return {
    baseUrl,
    token,
    username,
    password,
    allowMutatingQueries: input.allowMutatingQueries === true,
    requestTimeoutMs: readBoundedInteger(input.requestTimeoutMs, DEFAULT_TIMEOUT_MS, {
      min: MIN_TIMEOUT_MS,
      max: Number.MAX_SAFE_INTEGER,
    }),
    maxRows: readBoundedInteger(input.maxRows, DEFAULT_MAX_ROWS, {
      min: MIN_ROWS,
      max: MAX_ROWS,
    }),
    maxChars: readBoundedInteger(input.maxChars, DEFAULT_MAX_CHARS, {
      min: MIN_CHARS,
      max: MAX_CHARS,
    }),
  };
}

function parseMindsdbAction(action: string): MindsdbAction {
  if ((MINDSDB_ACTIONS as readonly string[]).includes(action)) {
    return action as MindsdbAction;
  }
  throw new Error(`Unknown action: ${action}. Valid actions: ${MINDSDB_ACTIONS.join(", ")}`);
}

export function createMindsdbTool(
  api: OpenClawPluginApi,
  pluginConfig: MindsdbPluginConfig = resolveMindsdbPluginConfig(api.pluginConfig),
): AnyAgentTool {
  let cachedToken: string | undefined;

  const resolveAuthHeader = async (): Promise<string | undefined> => {
    if (pluginConfig.token) {
      return `Bearer ${pluginConfig.token}`;
    }

    if (pluginConfig.username && pluginConfig.password) {
      if (!cachedToken) {
        cachedToken = await fetchLoginToken(pluginConfig);
      }
      return `Bearer ${cachedToken}`;
    }

    return undefined;
  };

  const executeAction = async (action: MindsdbAction, params: MindsdbToolParams) => {
    const authHeader = await resolveAuthHeader();

    if (action === "list_databases") {
      return requestJson({
        baseUrl: pluginConfig.baseUrl,
        path: "/api/sql/list_databases",
        method: "GET",
        authHeader,
        timeoutMs: pluginConfig.requestTimeoutMs,
      });
    }

    if (action === "parametrize_constants") {
      if (!params.query) {
        throw new Error("query required for parametrize_constants");
      }
      return requestJson({
        baseUrl: pluginConfig.baseUrl,
        path: "/api/sql/query/utils/parametrize_constants",
        method: "POST",
        body: { query: params.query },
        authHeader,
        timeoutMs: pluginConfig.requestTimeoutMs,
      });
    }

    if (!params.query) {
      throw new Error("query required for query action");
    }

    if (!pluginConfig.allowMutatingQueries && looksMutatingQuery(params.query)) {
      throw new Error(
        "Mutating queries are disabled by plugin config. Set plugins.entries.mindsdb.config.allowMutatingQueries=true to enable CREATE/INSERT/UPDATE/DELETE/ALTER operations.",
      );
    }

    const body: JsonRecord = { query: params.query };
    if (params.params) {
      body.params = params.params;
    }
    if (params.context) {
      body.context = params.context;
    }

    return requestJson({
      baseUrl: pluginConfig.baseUrl,
      path: "/api/sql/query",
      method: "POST",
      body,
      authHeader,
      timeoutMs: pluginConfig.requestTimeoutMs,
    });
  };

  return {
    name: "mindsdb",
    label: "MindsDB",
    description:
      "Query MindsDB's federated SQL engine to access connected databases with one tool.",
    parameters: MindsdbToolSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const action = parseMindsdbAction(readStringParam(rawParams, "action", { required: true }));
      const query = readStringParam(rawParams, "query");
      const params = readRecordParam(rawParams, "params");
      const context = readRecordParam(rawParams, "context");

      try {
        const responsePayload = await executeAction(action, {
          action,
          query,
          params,
          context,
        });

        const totalRows = tableRowCount(responsePayload);
        const previewPayload = previewResponse(responsePayload, pluginConfig.maxRows);
        const shownRows = tableRowCount(previewPayload);
        const rendered = renderPayload(previewPayload, pluginConfig.maxChars);

        return {
          content: [{ type: "text", text: rendered.text }],
          details: {
            action,
            responseType: responseType(responsePayload),
            totalRows,
            shownRows,
            outputTruncated: rendered.truncated,
            outputChars: rendered.originalChars,
            baseUrl: pluginConfig.baseUrl,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[mindsdb:${action}] ${message}`);
      }
    },
  } satisfies AnyAgentTool;
}
