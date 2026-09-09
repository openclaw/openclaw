import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { assertSignalSocketEndpoint } from "./socket-path.js";

const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;

type RpcMessage = Record<string, unknown>;
type UnixOptions = { baseUrl: string; timeoutMs?: number; maxResponseBytes?: number };

function socketPath(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (
    url.protocol !== "unix:" ||
    url.host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Signal UNIX URL must contain only an absolute socket path");
  }
  return fileURLToPath(`file://${url.pathname}`);
}

function abortError(): Error {
  return Object.assign(new Error("Signal UNIX stream aborted"), { name: "AbortError" });
}

async function openSocket(options: UnixOptions, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) {
    throw abortError();
  }
  const path = socketPath(options.baseUrl);
  await assertSignalSocketEndpoint(path);
  if (abortSignal?.aborted) {
    throw abortError();
  }
  const socket = net.createConnection({ path });
  // Keep errors observed even before the iterator starts or while a consumer is awaiting work.
  socket.on("error", () => {});
  const timeoutMs = resolveTimerTimeoutMs(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const deadline = setTimeout(() => {
    socket.destroy(new Error(`Signal UNIX RPC exceeded deadline after ${timeoutMs}ms`));
  }, timeoutMs);
  deadline.unref();
  const onAbort = () => socket.destroy(abortError());
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    socket,
    ready: () => clearTimeout(deadline),
    close: () => {
      clearTimeout(deadline);
      abortSignal?.removeEventListener("abort", onAbort);
      socket.destroy();
    },
  };
}

async function* messages(socket: net.Socket, maxBytes = MAX_FRAME_BYTES) {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("Signal UNIX RPC expected a byte stream");
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (pending.length + fragment.length > maxBytes) {
        throw new Error("Signal UNIX RPC frame exceeded size limit");
      }
      pending = Buffer.concat([pending, fragment]);
      if (newline < 0) {
        break;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(pending);
      pending = Buffer.alloc(0);
      offset = newline + 1;
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) {
        throw new Error("Signal UNIX RPC returned invalid response envelope");
      }
      yield parsed;
    }
  }
  if (pending.length) {
    throw new Error("Signal UNIX RPC closed with an incomplete frame");
  }
}

function result(message: RpcMessage): unknown {
  if (message.jsonrpc !== "2.0" || (!Object.hasOwn(message, "result") && !message.error)) {
    throw new Error("Signal UNIX RPC returned invalid response envelope");
  }
  if (message.error) {
    const error = isRecord(message.error) ? message.error : {};
    const code = typeof error.code === "number" ? error.code : "unknown";
    const errorMessage = typeof error.message === "string" ? error.message : "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${errorMessage}`);
  }
  return message.result;
}

export async function signalUnixRpcRequest<T>(
  method: string,
  params: Record<string, unknown> | undefined,
  options: UnixOptions,
): Promise<T> {
  const connection = await openSocket(options);
  const id = randomUUID();
  const maxBytes =
    typeof options.maxResponseBytes === "number" &&
    Number.isFinite(options.maxResponseBytes) &&
    options.maxResponseBytes >= 1
      ? Math.floor(options.maxResponseBytes)
      : MAX_FRAME_BYTES;
  try {
    connection.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for await (const message of messages(connection.socket, maxBytes)) {
      if (message.id === id) {
        // SAFETY: The generic caller owns the method's result type after JSON-RPC envelope validation.
        return result(message) as T;
      }
    }
    throw new Error("Signal UNIX RPC closed before response");
  } finally {
    connection.close();
  }
}

export async function streamSignalUnixEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (event: { event?: string; data?: string; id?: string }) => unknown;
  onStreamOpen?: () => void;
}): Promise<void> {
  // The monitor uses zero for unlimited stream idle time, not a 1 ms handshake.
  // Bound subscription establishment separately; ready() clears it after acknowledgement.
  const connection = await openSocket(
    { ...params, timeoutMs: params.timeoutMs === 0 ? DEFAULT_TIMEOUT_MS : params.timeoutMs },
    params.abortSignal,
  );
  const id = randomUUID();
  let subscribed = false;
  let subscription: number | undefined;
  try {
    connection.socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "subscribeReceive",
        params: params.account ? { account: params.account } : undefined,
      })}\n`,
    );
    for await (const message of messages(connection.socket)) {
      if (params.abortSignal?.aborted) {
        throw abortError();
      }
      if (message.id === id) {
        const value = result(message);
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new Error("Signal UNIX RPC returned invalid receive subscription");
        }
        subscription = value;
        subscribed = true;
        connection.ready();
        params.onStreamOpen?.();
        continue;
      }
      if (message.jsonrpc !== "2.0" || message.method !== "receive" || !isRecord(message.params)) {
        continue;
      }
      const notification = message.params;
      // signal-cli manual receive wraps the regular SSE payload in a subscription result.
      if (subscription !== undefined && notification.subscription !== subscription) {
        continue;
      }
      const payload = notification.result;
      if (!isRecord(payload)) {
        continue;
      }
      const account = payload.account;
      if (params.account && typeof account === "string" && account !== params.account) {
        continue;
      }
      await params.onEvent({ event: "receive", data: JSON.stringify(payload) });
    }
    if (!subscribed) {
      throw new Error("Signal UNIX RPC closed before receive subscription");
    }
  } finally {
    // signal-cli removes connection-owned subscriptions when the socket closes.
    connection.close();
  }
}
