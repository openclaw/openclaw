// Line plugin module implements download behavior.
import { messagingApi } from "@line/bot-sdk";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

/**
 * Default per-chunk idle timeout for LINE inbound media downloads.
 *
 * Matches the Telegram `TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000` ceiling so
 * a stalled LINE content stream cannot block inbound dispatch indefinitely.
 * Idle (not overall) so legitimate slow-but-progressing transfers continue.
 */
export const LINE_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export class LineMediaDownloadTimeoutError extends Error {
  readonly chunkTimeoutMs: number;
  constructor(chunkTimeoutMs: number) {
    super(`LINE media download stalled: no data received for ${chunkTimeoutMs}ms`);
    this.name = "LineMediaDownloadTimeoutError";
    this.chunkTimeoutMs = chunkTimeoutMs;
  }
}

// Wraps an AsyncIterable so each `next()` is bounded by `chunkTimeoutMs`. On
// timeout we propagate `LineMediaDownloadTimeoutError` and call `return()` on
// the upstream iterator. For Node `Readable` produced by `@line/bot-sdk`
// `convertResponseToReadable`, that triggers `Readable.destroy()`, which stops
// further `read()` calls. The underlying `fetch` itself is NOT cancelled —
// `@line/bot-sdk`'s `HTTPFetchClient.get` does not accept `AbortSignal`, so the
// in-flight HTTP body may continue draining the TCP buffer until the OS
// keep-alive timer fires. The caller (and any concurrent inbound dispatch) is
// unblocked immediately; the orphaned fetch is bounded by transport, not by
// this code.
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
              () => reject(new LineMediaDownloadTimeoutError(chunkTimeoutMs)),
              chunkTimeoutMs,
            );
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([nextPromise, timeoutPromise]);
          } catch (err) {
            // The timeout won the race; `nextPromise` is still pending and may
            // later reject (e.g., the upstream Readable emits an error after
            // `destroy()`). Without this, that rejection escapes as
            // `unhandledRejection` and is fatal on Node 22+.
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

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
  options?: { chunkTimeoutMs?: number },
): Promise<DownloadResult> {
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? LINE_DOWNLOAD_IDLE_TIMEOUT_MS;
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  // Race the headers-level fetch against the same idle ceiling. `@line/bot-sdk`
  // currently builds its fetch without `AbortSignal`, so a server that never
  // returns headers cannot otherwise be capped here. The fetch itself keeps
  // running on timeout (see `withChunkIdleTimeout` note above for the same
  // limitation on the body phase).
  let responseTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const responseTimeoutPromise = new Promise<never>((_, reject) => {
    responseTimeoutHandle = setTimeout(
      () => reject(new LineMediaDownloadTimeoutError(chunkTimeoutMs)),
      chunkTimeoutMs,
    );
  });
  const responsePromise = client.getMessageContent(messageId);
  let response: Awaited<ReturnType<typeof client.getMessageContent>>;
  try {
    response = await Promise.race([responsePromise, responseTimeoutPromise]);
  } catch (err) {
    // Same as `withChunkIdleTimeout`: suppress any later rejection from the
    // orphaned `responsePromise` so it does not become an `unhandledRejection`.
    responsePromise.then(
      () => undefined,
      () => undefined,
    );
    throw err;
  } finally {
    if (responseTimeoutHandle !== undefined) {
      clearTimeout(responseTimeoutHandle);
    }
  }

  const guardedStream = withChunkIdleTimeout(
    response as unknown as AsyncIterable<Buffer>,
    chunkTimeoutMs,
  );
  const saved = await saveMediaStream(guardedStream, undefined, "inbound", maxBytes);
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
