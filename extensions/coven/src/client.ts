import net from "node:net";

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
  listEvents(sessionId: string, signal?: AbortSignal): Promise<CovenEventRecord[]>;
  sendInput(sessionId: string, data: string, signal?: AbortSignal): Promise<void>;
  killSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

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

function parseHttpResponse(raw: string): HttpResponse {
  const [head = "", ...bodyParts] = raw.split("\r\n\r\n");
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(head);
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    body: bodyParts.join("\r\n\r\n"),
  };
}

function requestOverSocket(options: RequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("request aborted"));
      return;
    }

    const socket = net.createConnection(options.socketPath);
    const chunks: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      socket.destroy();
      settle(() => reject(options.signal?.reason ?? new Error("request aborted")));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => {
      const body = options.body === undefined ? "" : JSON.stringify(options.body);
      const headers = [
        `${options.method} ${options.path} HTTP/1.1`,
        "Host: coven",
        "Connection: close",
        ...(body
          ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`]
          : []),
        "",
        body,
      ];
      socket.write(headers.join("\r\n"));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", (error) => settle(() => reject(error)));
    socket.on("end", () => {
      const response = parseHttpResponse(Buffer.concat(chunks).toString("utf8"));
      settle(() => resolve(response));
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      const response = parseHttpResponse(Buffer.concat(chunks).toString("utf8"));
      settle(() => resolve(response));
    });
  });
}

async function requestJson<T>(options: RequestOptions): Promise<T> {
  const response = await requestOverSocket(options);
  if (response.status < 200 || response.status >= 300) {
    throw new CovenApiError(response.status, response.body);
  }
  return JSON.parse(response.body || "null") as T;
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
    listEvents(sessionId, signal) {
      return requestJson<CovenEventRecord[]>({
        socketPath,
        method: "GET",
        path: `/events?sessionId=${encodeURIComponent(sessionId)}`,
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
