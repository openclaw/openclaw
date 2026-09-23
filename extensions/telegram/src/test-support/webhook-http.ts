import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const WEBHOOK_DRAIN_GUARD_MS = 5;

export async function yieldWebhookTask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function collectResponseBody(
  res: IncomingMessage,
  onDone: (payload: { statusCode: number; body: string }) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on("end", () => {
    onDone({
      statusCode: res.statusCode ?? 0,
      body: Buffer.concat(chunks).toString("utf-8"),
    });
  });
}

function createSingleSettlement<T>(params: {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  clear: () => void;
}) {
  let settled = false;
  return {
    isSettled() {
      return settled;
    },
    resolve(value: T) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.resolve(value);
    },
    reject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.reject(error);
    },
  };
}

export async function fetchWithTimeout(
  input: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function postWebhookJson(params: {
  url: string;
  payload: string;
  secret?: string;
  timeoutMs?: number;
}): Promise<Response> {
  return await fetchWithTimeout(
    params.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
      },
      body: params.payload,
    },
    params.timeoutMs ?? 5_000,
  );
}

export async function postWebhookHeadersOnly(params: {
  port: number;
  path: string;
  declaredLength: number;
  secret?: string;
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const settle = createSingleSettlement({
      resolve,
      reject,
      clear: () => clearTimeout(timeout),
    });

    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(params.declaredLength),
          ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
        },
      },
      (res) => {
        collectResponseBody(res, (payload) => {
          settle.resolve(payload);
          req.destroy();
        });
      },
    );

    const timeout = setTimeout(() => {
      req.destroy(
        new Error(`webhook header-only post timed out after ${params.timeoutMs ?? 5_000}ms`),
      );
      settle.reject(new Error("timed out waiting for webhook response"));
    }, params.timeoutMs ?? 5_000);

    req.on("error", (error) => {
      if (settle.isSettled() && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
        return;
      }
      settle.reject(error);
    });

    req.flushHeaders();
  });
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export async function postWebhookPayloadWithChunkPlan(params: {
  port: number;
  path: string;
  payload: string;
  secret: string;
  mode: "single" | "random-chunked";
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  const payloadBuffer = Buffer.from(params.payload, "utf-8");
  return await new Promise((resolve, reject) => {
    let bytesQueued = 0;
    let chunksQueued = 0;
    let phase: "writing" | "awaiting-response" = "writing";
    const settle = createSingleSettlement({
      resolve,
      reject,
      clear: () => clearTimeout(timeout),
    });

    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payloadBuffer.length),
          "x-telegram-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        collectResponseBody(res, settle["resolve"]);
      },
    );

    const timeout = setTimeout(() => {
      settle.reject(
        new Error(
          `webhook post timed out after ${params.timeoutMs ?? 15_000}ms (phase=${phase}, bytesQueued=${bytesQueued}, chunksQueued=${chunksQueued}, totalBytes=${payloadBuffer.length})`,
        ),
      );
      req.destroy();
    }, params.timeoutMs ?? 15_000);

    req.on("error", (error) => {
      settle.reject(error);
    });

    const writeAll = async () => {
      if (params.mode === "single") {
        req.end(payloadBuffer);
        return;
      }

      const rng = createDeterministicRng(26156);
      let offset = 0;
      while (offset < payloadBuffer.length) {
        const remaining = payloadBuffer.length - offset;
        const nextSize = Math.max(1, Math.min(remaining, 1 + Math.floor(rng() * 8_192)));
        const chunk = payloadBuffer.subarray(offset, offset + nextSize);
        const canContinue = req.write(chunk);
        offset += nextSize;
        bytesQueued = offset;
        chunksQueued += 1;
        if (chunksQueued % 10 === 0) {
          await yieldWebhookTask();
        }
        if (!canContinue) {
          // Windows CI occasionally stalls on waiting for drain indefinitely.
          // Bound the wait, then continue queuing this small (~1MB) payload.
          await Promise.race([once(req, "drain"), sleep(WEBHOOK_DRAIN_GUARD_MS)]);
        }
      }
      phase = "awaiting-response";
      req.end();
    };

    void writeAll().catch((error: unknown) => {
      settle.reject(error);
    });
  });
}
