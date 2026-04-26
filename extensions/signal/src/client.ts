import { Buffer } from "node:buffer";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
};

export type SignalRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

type SignalHttpResponse = {
  status: number;
  statusText: string;
  text: string;
};

function createSignalSseAbortError(): Error {
  const error = new Error("Signal SSE aborted");
  error.name = "AbortError";
  return error;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function parseSignalRpcResponse<T>(text: string, status: number): SignalRpcResponse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Signal RPC returned malformed JSON (status ${status})`, { cause: err });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
  }

  const rpc = parsed as SignalRpcResponse<T>;
  const hasResult = Object.hasOwn(rpc, "result");
  if (!rpc.error && !hasResult) {
    throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
  }
  return rpc;
}

function assertSignalHttpProtocol(url: URL, label: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Signal ${label} unsupported protocol: ${url.protocol}`);
  }
}

function requestSignalHttpText(
  url: URL,
  options: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<SignalHttpResponse> {
  assertSignalHttpProtocol(url, "HTTP");
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const cleanup = () => {
      request?.setTimeout(0);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (response: SignalHttpResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    request = client.request(
      url,
      {
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("error", rejectOnce);
        res.on("end", () => {
          resolveOnce({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage || "error",
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(options.timeoutMs, () => {
      request?.destroy(new Error(`Signal HTTP timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", rejectOnce);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = generateSecureUuid();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  const res = await requestSignalHttpText(new URL(`${baseUrl}/api/v1/rpc`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (res.status === 201) {
    return undefined as T;
  }
  if (!res.text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }
  const parsed = parseSignalRpcResponse<T>(res.text, res.status);
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }
  return parsed.result as T;
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await requestSignalHttpText(new URL(`${normalized}/api/v1/check`), {
      method: "GET",
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: formatErrorMessage(err),
    };
  }
}

function openSignalEventStream(
  url: URL,
  abortSignal?: AbortSignal,
): Promise<{ response: IncomingMessage; cleanup: () => void }> {
  assertSignalHttpProtocol(url, "SSE");
  if (abortSignal?.aborted) {
    throw createSignalSseAbortError();
  }

  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let onAbort: () => void = () => {};
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const request = client.request(
      url,
      {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          rejectOnce(new Error(`Signal SSE failed (${status} ${res.statusMessage || "error"})`));
          return;
        }
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        response = res;
        resolve({ response: res, cleanup });
      },
    );
    onAbort = () => {
      const error = createSignalSseAbortError();
      response?.destroy(error);
      request.destroy(error);
      rejectOnce(error);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", rejectOnce);
    request.end();
  });
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const { response, cleanup } = await openSignalEventStream(url, params.abortSignal);
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  const processLine = (line: string) => {
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const [rawField, ...rest] = line.split(":");
    const field = rawField.trim();
    const rawValue = rest.join(":");
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      currentEvent.event = value;
    } else if (field === "data") {
      currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
    } else if (field === "id") {
      currentEvent.id = value;
    }
  };

  const drainCompleteLines = () => {
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      processLine(line);
      lineEnd = buffer.indexOf("\n");
    }
  };

  try {
    for await (const chunk of response as AsyncIterable<Buffer | string>) {
      const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffer += decoder.decode(value, { stream: true });
      drainCompleteLines();
    }
    buffer += decoder.decode();
    drainCompleteLines();
  } finally {
    cleanup();
  }

  flushEvent();
}
