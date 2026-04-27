import http from "node:http";

export type CovenSessionRecord = {
  id: string;
  projectRoot: string;
  harness: string;
  title: string;
  status: string;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CovenEventRecord = {
  id: string;
  sessionId: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
};

export type CovenHealthResponse = {
  ok: boolean;
  daemon?: {
    pid: number;
    startedAt: string;
    socket: string;
  } | null;
};

export type LaunchCovenSessionInput = {
  projectRoot: string;
  cwd: string;
  harness: string;
  prompt: string;
  title: string;
};

export interface CovenClient {
  health(signal?: AbortSignal): Promise<CovenHealthResponse>;
  launchSession(input: LaunchCovenSessionInput, signal?: AbortSignal): Promise<CovenSessionRecord>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<CovenSessionRecord>;
  listEvents(
    sessionId: string,
    options?: CovenListEventsOptions,
    signal?: AbortSignal,
  ): Promise<CovenEventRecord[]>;
  sendInput(sessionId: string, data: string, signal?: AbortSignal): Promise<void>;
  killSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export type CovenListEventsOptions = {
  afterEventId?: string;
};

type RequestOptions = {
  socketPath: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
};

type HttpResponse = {
  status: number;
  body: string;
};

export class CovenApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Coven API returned HTTP ${status || "unknown"}`);
    this.name = "CovenApiError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;

function requestOverSocket(options: RequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("request aborted"));
      return;
    }

    let settled = false;
    let body = "";
    let totalBytes = 0;

    const settle = (fn: () => void, req?: http.ClientRequest) => {
      if (settled) {
        return;
      }
      settled = true;
      req?.destroy();
      fn();
    };

    const requestBody = options.body === undefined ? "" : JSON.stringify(options.body);
    const req = http.request(
      {
        socketPath: options.socketPath,
        method: options.method,
        path: options.path,
        headers: {
          Host: "coven",
          Connection: "close",
          ...(requestBody
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestBody),
              }
            : {}),
        },
        signal: options.signal,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (settled) {
            return;
          }
          totalBytes += Buffer.byteLength(chunk);
          if (totalBytes > MAX_RESPONSE_BYTES) {
            settle(() => reject(new Error("Coven API response exceeded size limit")), req);
            return;
          }
          body += chunk;
        });
        res.on("end", () => {
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              body,
            }),
          );
        });
        res.on("error", (error) => settle(() => reject(error), req));
      },
    );
    req.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS, () => {
      settle(() => reject(new Error("Coven API request timed out")), req);
    });
    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settle(() => reject(error));
    });
    req.end(requestBody);
  });
}

async function requestJson<T>(options: RequestOptions): Promise<T> {
  const response = await requestOverSocket(options);
  if (response.status < 200 || response.status >= 300) {
    throw new CovenApiError(response.status, response.body);
  }
  try {
    return JSON.parse(response.body || "null") as T;
  } catch (error) {
    throw new CovenApiError(response.status, `Invalid JSON response: ${String(error)}`);
  }
}

export function createCovenClient(socketPath: string): CovenClient {
  return {
    health(signal) {
      return requestJson<CovenHealthResponse>({
        socketPath,
        method: "GET",
        path: "/health",
        signal,
      });
    },
    launchSession(input, signal) {
      return requestJson<CovenSessionRecord>({
        socketPath,
        method: "POST",
        path: "/sessions",
        body: input,
        signal,
      });
    },
    getSession(sessionId, signal) {
      return requestJson<CovenSessionRecord>({
        socketPath,
        method: "GET",
        path: `/sessions/${encodeURIComponent(sessionId)}`,
        signal,
      });
    },
    listEvents(sessionId, options, signal) {
      const params = new URLSearchParams({ sessionId });
      const afterEventId = options?.afterEventId?.trim();
      if (afterEventId) {
        params.set("afterEventId", afterEventId);
      }
      return requestJson<CovenEventRecord[]>({
        socketPath,
        method: "GET",
        path: `/events?${params.toString()}`,
        signal,
      });
    },
    async sendInput(sessionId, data, signal) {
      await requestJson<unknown>({
        socketPath,
        method: "POST",
        path: `/sessions/${encodeURIComponent(sessionId)}/input`,
        body: { data },
        signal,
      });
    },
    async killSession(sessionId, signal) {
      await requestJson<unknown>({
        socketPath,
        method: "POST",
        path: `/sessions/${encodeURIComponent(sessionId)}/kill`,
        signal,
      });
    },
  };
}
