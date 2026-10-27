import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

function destroySource(source: unknown) {
  const s = source as { destroy?: () => void };
  if (typeof s.destroy === "function") {
    s.destroy();
  }
}

// Bound each AsyncIterable `next()` so a stalled Lark download cannot hang
// inbound dispatch. Destroying the source on timeout releases the SDK's
// underlying Node Readable and HTTP connection.
function withChunkIdleTimeout<T>(
  source: AsyncIterable<T>,
  chunkTimeoutMs: number,
  teardownSource: () => void,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const nextPromise = iterator.next();
          let result: IteratorResult<T>;
          try {
            result = await raceWithTimeout(nextPromise, chunkTimeoutMs, () => {
              throw Object.assign(
                new Error(
                  `Feishu media download stalled: no data received for ${chunkTimeoutMs}ms`,
                ),
                { name: "FeishuInboundMediaTimeoutError" },
              );
            });
          } catch (error) {
            // Settle the timeout before teardown can synchronously finish next().
            teardownSource();
            throw error;
          }
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!exhausted && typeof iterator.return === "function") {
          // A stalled Node Readable can keep return() pending. Source teardown
          // already owns cleanup, so observe the promise without awaiting it.
          iterator.return().catch(() => undefined);
        }
      }
    },
  };
}

export async function saveMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName: string | undefined,
  chunkTimeoutMs: number,
): Promise<SavedMedia> {
  let teardownAttempted = false;
  const teardownSource = () => {
    if (teardownAttempted) {
      return;
    }
    teardownAttempted = true;
    try {
      destroySource(stream);
    } catch {
      // Teardown must not replace the storage or timeout error.
    }
  };
  try {
    return await saveMediaStream(
      withChunkIdleTimeout(stream, chunkTimeoutMs, teardownSource),
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );
  } catch (error) {
    teardownSource();
    throw error;
  }
}
