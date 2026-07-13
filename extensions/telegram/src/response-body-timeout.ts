// Telegram helpers for bounded Bot API response body reads.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

type TimeoutErrorFactory = (params: { timeoutMs: number }) => Error;

type ReadTelegramResponseBodyOptions = {
  maxBytes: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  onIdleTimeout: TimeoutErrorFactory;
  onDeadlineTimeout: TimeoutErrorFactory;
};

function resolveBodyTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveBodyIdleTimeoutMs(timeoutMs: number, idleTimeoutMs?: number): number {
  const deadlineTimeoutMs = resolveBodyTimeoutMs(timeoutMs);
  const resolvedIdleTimeoutMs =
    idleTimeoutMs === undefined ? Math.floor(deadlineTimeoutMs / 2) : idleTimeoutMs;
  return Math.max(1, Math.min(deadlineTimeoutMs, Math.floor(resolvedIdleTimeoutMs)));
}

function unrefTimer(timeout: ReturnType<typeof setTimeout>): void {
  if (typeof timeout === "object" && "unref" in timeout) {
    (timeout as { unref: () => void }).unref();
  }
}

function contentTooLargeError(size: number, maxBytes: number): Error {
  return new Error(`Content too large: ${size} bytes (limit: ${maxBytes} bytes)`);
}

function cancelResponseBody(response: Response, error: Error): void {
  const body = response.body as { cancel?: (reason?: unknown) => Promise<unknown> } | null;
  void body?.cancel?.(error).catch(() => undefined);
}

async function readChunkWithTimeouts(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  deadline: Promise<never>,
  onIdleTimeout: TimeoutErrorFactory,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    idleTimer = setTimeout(() => {
      const error = onIdleTimeout({ timeoutMs: idleTimeoutMs });
      reject(error);
      void reader.cancel(error).catch(() => undefined);
    }, idleTimeoutMs);
    unrefTimer(idleTimer);
  });

  try {
    return await Promise.race([reader.read(), idle, deadline]);
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}

async function readStreamBodyWithTimeout(
  response: Response,
  options: ReadTelegramResponseBodyOptions,
): Promise<Buffer> {
  const bodyTimeoutMs = resolveBodyTimeoutMs(options.timeoutMs);
  const idleTimeoutMs = resolveBodyIdleTimeoutMs(options.timeoutMs, options.idleTimeoutMs);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = options.onDeadlineTimeout({ timeoutMs: bodyTimeoutMs });
      reject(error);
      void reader.cancel(error).catch(() => undefined);
    }, bodyTimeoutMs);
    unrefTimer(deadlineTimer);
  });

  try {
    while (true) {
      const { done, value } = await readChunkWithTimeouts(
        reader,
        idleTimeoutMs,
        deadline,
        options.onIdleTimeout,
      );
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }
      const nextTotal = total + value.length;
      if (nextTotal > options.maxBytes) {
        const error = contentTooLargeError(nextTotal, options.maxBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
      total = nextTotal;
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    );
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function readFallbackBodyWithTimeout(
  response: Response,
  options: ReadTelegramResponseBodyOptions,
): Promise<Buffer> {
  const bodyTimeoutMs = resolveBodyTimeoutMs(options.timeoutMs);
  const idleTimeoutMs = resolveBodyIdleTimeoutMs(options.timeoutMs, options.idleTimeoutMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = options.onDeadlineTimeout({ timeoutMs: bodyTimeoutMs });
      reject(error);
      cancelResponseBody(response, error);
    }, bodyTimeoutMs);
    unrefTimer(deadlineTimer);
  });

  try {
    return await Promise.race([
      readResponseWithLimit(response, options.maxBytes, {
        chunkTimeoutMs: idleTimeoutMs,
        onIdleTimeout: ({ chunkTimeoutMs }) => options.onIdleTimeout({ timeoutMs: chunkTimeoutMs }),
      }),
      deadline,
    ]);
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

export async function readTelegramResponseBodyWithTimeout(
  response: Response,
  options: ReadTelegramResponseBodyOptions,
): Promise<Buffer> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return await readFallbackBodyWithTimeout(response, options);
  }
  return await readStreamBodyWithTimeout(response, options);
}
