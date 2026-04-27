import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { lstatIfExists, pathIsInside } from "./path-utils.js";

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
  socketRoot?: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
};

type HttpResponse = {
  status: number;
  body: string;
};

type SocketFingerprint = {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
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
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_SOCKET_FILENAME = "coven.sock";
const SAFE_QUERY_ID_REGEX = /^[A-Za-z0-9._:-]+$/;
const MAX_QUERY_ID_CHARS = 256;

function statExistingPath(filePath: string, label: string): fs.Stats {
  try {
    return fs.statSync(filePath);
  } catch {
    throw new Error(`${label} must exist`);
  }
}

function realpathExistingPath(filePath: string, label: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    throw new Error(`${label} must exist`);
  }
}

function fingerprintSocket(stat: fs.Stats): SocketFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function socketFingerprintMatches(left: SocketFingerprint, right: SocketFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function validateSocketPathForUse(
  socketPath: string,
  socketRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
): SocketFingerprint | null {
  if (!socketRoot) {
    return null;
  }
  validateSocketPlatform(platform);
  const socketRootLstat = lstatIfExists(socketRoot);
  if (socketRootLstat?.isSymbolicLink()) {
    throw new Error("Coven covenHome must not be a symlink");
  }
  const socketRootStat = statExistingPath(socketRoot, "Coven covenHome");
  validateSocketOwnerAndMode(socketRootStat, "Coven covenHome", platform);
  validatePrivateDirectory(socketRootStat, "Coven covenHome", platform);
  const expectedSocketPath = path.resolve(socketRoot, DEFAULT_SOCKET_FILENAME);
  if (path.resolve(socketPath) !== expectedSocketPath) {
    throw new Error("Coven socketPath must be <covenHome>/coven.sock");
  }

  const socketStat = lstatIfExists(socketPath);
  if (socketStat?.isSymbolicLink()) {
    throw new Error("Coven socketPath must not be a symlink");
  }
  const resolvedSocketStat = statExistingPath(socketPath, "Coven socketPath");
  if (!resolvedSocketStat.isSocket()) {
    throw new Error("Coven socketPath must be a Unix socket");
  }
  validateSocketOwnerAndMode(resolvedSocketStat, "Coven socketPath", platform);

  const realSocketRoot = realpathExistingPath(socketRoot, "Coven covenHome");
  const realSocketDir = realpathExistingPath(
    path.dirname(socketPath),
    "Coven socketPath directory",
  );
  const socketDirStat = statExistingPath(path.dirname(socketPath), "Coven socketPath directory");
  validateSocketOwnerAndMode(socketDirStat, "Coven socketPath directory", platform);
  validatePrivateDirectory(socketDirStat, "Coven socketPath directory", platform);
  if (!pathIsInside(realSocketRoot, realSocketDir)) {
    throw new Error("Coven socketPath must stay inside covenHome");
  }
  const realSocketPath = realpathExistingPath(socketPath, "Coven socketPath");
  if (!pathIsInside(realSocketRoot, realSocketPath)) {
    throw new Error("Coven socketPath must stay inside covenHome");
  }
  return fingerprintSocket(resolvedSocketStat);
}

function validateSocketPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error("Coven Unix socket validation is not supported on Windows");
  }
}

function requireSafeQueryId(input: string, label: string): string {
  const value = input.trim();
  if (!value || value.length > MAX_QUERY_ID_CHARS || !SAFE_QUERY_ID_REGEX.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateSocketOwnerAndMode(
  stat: fs.Stats,
  label: string,
  platform: NodeJS.Platform,
): void {
  validateSocketPlatform(platform);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid != null && stat.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group or world writable`);
  }
}

function validatePrivateDirectory(stat: fs.Stats, label: string, platform: NodeJS.Platform): void {
  validateSocketPlatform(platform);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group or world accessible`);
  }
}

function serializeRequestBody(body: unknown): { text: string; byteLength: number } {
  if (body === undefined) {
    return { text: "", byteLength: 0 };
  }
  const text = JSON.stringify(body) ?? "";
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Coven API request exceeded size limit");
  }
  return { text, byteLength };
}

function errorToError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function socketThatFailsWith(error: unknown): net.Socket {
  const socket = new net.Socket();
  queueMicrotask(() => socket.destroy(errorToError(error)));
  return socket;
}

function requestOverSocket(options: RequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("request aborted"));
      return;
    }
    let requestBody = "";
    let requestBodyBytes = 0;
    let socketFingerprint: SocketFingerprint | null = null;
    try {
      socketFingerprint = validateSocketPathForUse(options.socketPath, options.socketRoot);
      const serialized = serializeRequestBody(options.body);
      requestBody = serialized.text;
      requestBodyBytes = serialized.byteLength;
    } catch (error) {
      reject(error);
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

    const req = http.request(
      {
        createConnection: () => {
          try {
            const beforeConnect = validateSocketPathForUse(options.socketPath, options.socketRoot);
            const socket = net.createConnection({ path: options.socketPath });
            socket.once("connect", () => {
              try {
                const afterConnect = validateSocketPathForUse(
                  options.socketPath,
                  options.socketRoot,
                );
                const expected = beforeConnect ?? socketFingerprint;
                if (expected && afterConnect && !socketFingerprintMatches(expected, afterConnect)) {
                  socket.destroy(new Error("Coven socketPath changed during connection"));
                }
              } catch (error) {
                socket.destroy(errorToError(error));
              }
            });
            return socket;
          } catch (error) {
            return socketThatFailsWith(error);
          }
        },
        method: options.method,
        path: options.path,
        headers: {
          Host: "coven",
          Connection: "close",
          ...(requestBody
            ? {
                "Content-Type": "application/json",
                "Content-Length": requestBodyBytes,
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

export function createCovenClient(
  socketPath: string,
  clientOptions: { socketRoot?: string } = {},
): CovenClient {
  return {
    health(signal) {
      return requestJson<CovenHealthResponse>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "GET",
        path: "/health",
        signal,
      });
    },
    launchSession(input, signal) {
      return requestJson<CovenSessionRecord>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "POST",
        path: "/sessions",
        body: input,
        signal,
      });
    },
    getSession(sessionId, signal) {
      return requestJson<CovenSessionRecord>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "GET",
        path: `/sessions/${encodeURIComponent(sessionId)}`,
        signal,
      });
    },
    listEvents(sessionId, options, signal) {
      const params = new URLSearchParams({
        sessionId: requireSafeQueryId(sessionId, "Coven session id"),
      });
      const afterEventId = options?.afterEventId?.trim();
      if (afterEventId) {
        params.set("afterEventId", requireSafeQueryId(afterEventId, "Coven event id"));
      }
      return requestJson<CovenEventRecord[]>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "GET",
        path: `/events?${params.toString()}`,
        signal,
      });
    },
    async sendInput(sessionId, data, signal) {
      await requestJson<unknown>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "POST",
        path: `/sessions/${encodeURIComponent(sessionId)}/input`,
        body: { data },
        signal,
      });
    },
    async killSession(sessionId, signal) {
      await requestJson<unknown>({
        socketPath,
        socketRoot: clientOptions.socketRoot,
        method: "POST",
        path: `/sessions/${encodeURIComponent(sessionId)}/kill`,
        signal,
      });
    },
  };
}

export const __testing = {
  validateSocketPathForUse,
};
