import { request } from "node:http";
import { setImmediate } from "node:timers/promises";

export async function yieldWebhookTask(): Promise<void> {
  await setImmediate();
}

function webhookRequest(
  params: { port: number; path: string; secret?: string; declaredLength: number },
  onDone: (payload: { statusCode: number; body: string }) => void,
) {
  return request(
    {
      hostname: "127.0.0.1",
      port: params.port,
      path: params.path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(params.declaredLength),
        ...(params.secret === undefined
          ? {}
          : { "x-telegram-bot-api-secret-token": params.secret }),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        onDone({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
      });
    },
  );
}

function createSingleSettlement<T>(params: {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  clear: () => void;
}) {
  let settled = false;
  const once =
    <A>(callback: (value: A) => void) =>
    (value: A) => {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      callback(value);
    };
  return { resolve: once(params.resolve), reject: once(params.reject) };
}

export async function postWebhookJson(params: {
  url: string;
  payload: string;
  secret?: string;
  timeoutMs?: number;
}): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), params.timeoutMs ?? 5_000);
  try {
    return await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
      },
      body: params.payload,
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

    const req = webhookRequest({ ...params, secret: params.secret || undefined }, (payload) => {
      settle.resolve(payload);
      req.destroy();
    });

    const timeout = setTimeout(() => {
      req.destroy(
        new Error(`webhook header-only post timed out after ${params.timeoutMs ?? 5_000}ms`),
      );
      settle.reject(new Error("timed out waiting for webhook response"));
    }, params.timeoutMs ?? 5_000);

    req.on("error", settle.reject);

    req.flushHeaders();
  });
}

export async function postWebhookWithDeclaredLength(params: {
  port: number;
  path: string;
  secret: string;
  declaredLength: number;
  body: string;
}): Promise<
  | { kind: "response"; statusCode: number; body: string }
  | { kind: "error"; code: string | undefined }
> {
  return await new Promise((resolve) => {
    const req = webhookRequest(params, (payload) => resolve({ kind: "response", ...payload }));
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ kind: "error", code: error.code });
    });
    req.end(params.body);
  });
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

    const req = webhookRequest({ ...params, declaredLength: payloadBuffer.length }, settle.resolve);

    const timeout = setTimeout(() => {
      settle.reject(
        new Error(
          `webhook post timed out after ${params.timeoutMs ?? 15_000}ms (phase=${phase}, bytesQueued=${bytesQueued}, chunksQueued=${chunksQueued}, totalBytes=${payloadBuffer.length})`,
        ),
      );
      req.destroy();
    }, params.timeoutMs ?? 15_000);

    req.on("error", settle.reject);

    const writeAll = async () => {
      if (params.mode === "single") {
        req.end(payloadBuffer);
        return;
      }

      let rngState = 26156;
      let offset = 0;
      while (offset < payloadBuffer.length) {
        const remaining = payloadBuffer.length - offset;
        rngState = (rngState * 1_664_525 + 1_013_904_223) >>> 0;
        const nextSize = Math.max(
          1,
          Math.min(remaining, 1 + Math.floor((rngState / 4_294_967_296) * 8_192)),
        );
        const chunk = payloadBuffer.subarray(offset, offset + nextSize);
        const written = new Promise<void>((resolveWrite, rejectWrite) => {
          req.write(chunk, (error) => {
            if (error) {
              rejectWrite(error);
            } else {
              resolveWrite();
            }
          });
        });
        offset += nextSize;
        bytesQueued = offset;
        chunksQueued += 1;
        await written;
        if (chunksQueued % 10 === 0) {
          await yieldWebhookTask();
        }
      }
      phase = "awaiting-response";
      req.end();
    };

    void writeAll().catch(settle.reject);
  });
}
