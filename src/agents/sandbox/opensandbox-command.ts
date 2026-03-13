type OpenSandboxOutputItem = {
  fd?: number;
  msg?: string;
};

type OpenSandboxStatusResult = {
  running: boolean;
  exitCode?: number;
};

type FetchJsonResult = {
  ok: boolean;
  status: number;
  payload?: unknown;
  text?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

function parseNestedPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.data;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return record;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function fetchJson(params: {
  url: string;
  method: "GET" | "POST";
  accessToken: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<FetchJsonResult> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 10_000);
  try {
    const res = await fetch(params.url, {
      method: params.method,
      headers: {
        "Content-Type": "application/json",
        "X-EXECD-ACCESS-TOKEN": params.accessToken,
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!text.trim()) {
      return { ok: res.ok, status: res.status, text };
    }
    try {
      return { ok: res.ok, status: res.status, payload: JSON.parse(text), text };
    } catch {
      return { ok: res.ok, status: res.status, text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function failWithHttp(prefix: string, result: FetchJsonResult): never {
  const nested = parseNestedPayload(result.payload);
  const message =
    (nested && readStringField(nested, ["error", "message", "msg"])) ||
    (result.text && result.text.trim()) ||
    `HTTP ${result.status}`;
  throw new Error(`${prefix}: ${message}`);
}

export async function openSandboxStartCommandSession(params: {
  baseUrl: string;
  accessToken: string;
  command: string;
  workdir: string;
  timeoutSec: number;
}): Promise<string> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/command`;
  const result = await fetchJson({
    url,
    method: "POST",
    accessToken: params.accessToken,
    body: {
      command: params.command,
      workdir: params.workdir,
      wait: false,
      timeout: params.timeoutSec,
    },
  });
  if (!result.ok) {
    failWithHttp("OpenSandbox start command failed", result);
  }
  const nested = parseNestedPayload(result.payload);
  if (!nested) {
    throw new Error("OpenSandbox start command failed: empty response payload");
  }
  const sessionId = readStringField(nested, [
    "session_id",
    "sessionId",
    "id",
    "command_session_id",
    "commandSessionId",
  ]);
  if (!sessionId) {
    throw new Error("OpenSandbox start command failed: missing session id in response");
  }
  return sessionId;
}

export async function openSandboxReadCommandStatus(params: {
  baseUrl: string;
  accessToken: string;
  sessionId: string;
}): Promise<OpenSandboxStatusResult> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/command/status/${encodeURIComponent(params.sessionId)}`;
  const result = await fetchJson({
    url,
    method: "GET",
    accessToken: params.accessToken,
  });
  if (!result.ok) {
    failWithHttp("OpenSandbox command status failed", result);
  }
  const nested = parseNestedPayload(result.payload) ?? {};
  const runningRaw =
    nested.running ??
    nested.is_running ??
    nested.active ??
    nested.isActive ??
    nested.in_progress ??
    nested.inProgress;
  const running =
    typeof runningRaw === "boolean"
      ? runningRaw
      : typeof runningRaw === "number"
        ? runningRaw !== 0
        : typeof runningRaw === "string"
          ? ["running", "true", "1", "yes"].includes(runningRaw.trim().toLowerCase())
          : false;
  const state = readStringField(nested, ["state", "status"]);
  if (!running && state) {
    const normalized = state.toLowerCase();
    if (normalized === "running" || normalized === "pending") {
      return { running: true };
    }
  }
  const exitCode = readNumberField(nested, ["exit_code", "exitCode", "code"]);
  return { running, exitCode };
}

export async function openSandboxReadCommandOutput(params: {
  baseUrl: string;
  accessToken: string;
  sessionId: string;
}): Promise<OpenSandboxOutputItem[]> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/command/output/${encodeURIComponent(params.sessionId)}`;
  const result = await fetchJson({
    url,
    method: "GET",
    accessToken: params.accessToken,
  });
  if (!result.ok) {
    failWithHttp("OpenSandbox command output failed", result);
  }
  const nested = parseNestedPayload(result.payload) ?? {};
  const output = nested.output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output
    .filter((item) => item && typeof item === "object")
    .map((item) => item as OpenSandboxOutputItem);
}

export async function openSandboxKillCommandSession(params: {
  baseUrl: string;
  accessToken: string;
  sessionId: string;
}): Promise<void> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/command/kill/${encodeURIComponent(params.sessionId)}`;
  const result = await fetchJson({
    url,
    method: "POST",
    accessToken: params.accessToken,
  });
  if (!result.ok) {
    failWithHttp("OpenSandbox kill command failed", result);
  }
}
