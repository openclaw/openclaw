// Feishu inbound media chunk-idle timeout helpers.
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";

/**
 * Default per-chunk idle timeout for Feishu inbound media streams.
 * Matches Telegram `TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000` so a stalled
 * Lark SDK body cannot block inbound dispatch indefinitely after headers/start.
 */
const FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

class FeishuInboundMediaTimeoutError extends Error {
  readonly chunkTimeoutMs: number;
  constructor(chunkTimeoutMs: number) {
    super(`Feishu media download stalled: no data received for ${chunkTimeoutMs}ms`);
    this.name = "FeishuInboundMediaTimeoutError";
    this.chunkTimeoutMs = chunkTimeoutMs;
  }
}

// Bound each AsyncIterable `next()` so a stalled Lark download cannot hang
// inbound dispatch. On timeout, call `return()` so Node Readable streams are
// destroyed; silence the losing `nextPromise` to avoid unhandledRejection.
function withChunkIdleTimeout<T>(
  source: AsyncIterable<T>,
  chunkTimeoutMs: number,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          const nextPromise = iterator.next();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new FeishuInboundMediaTimeoutError(chunkTimeoutMs)),
              chunkTimeoutMs,
            );
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([nextPromise, timeoutPromise]);
          } catch (err) {
            nextPromise.then(
              () => undefined,
              () => undefined,
            );
            throw err;
          } finally {
            if (timeoutHandle !== undefined) {
              clearTimeout(timeoutHandle);
            }
          }
          if (result.done) {
            return;
          }
          yield result.value;
        }
      } finally {
        if (typeof iterator.return === "function") {
          await iterator.return().catch(() => undefined);
        }
      }
    },
  };
}

export function saveMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName?: string,
  chunkTimeoutMs: number = FEISHU_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
): Promise<SavedMedia> {
  return saveMediaStream(
    withChunkIdleTimeout(stream, chunkTimeoutMs),
    contentType,
    "inbound",
    maxBytes,
    fileName,
  );
}
