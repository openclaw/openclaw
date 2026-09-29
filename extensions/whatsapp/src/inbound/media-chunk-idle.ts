// WhatsApp owns the idle lifetime of its inbound Baileys media streams.
import { Readable } from "node:stream";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";

const WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

class WhatsAppInboundMediaTimeoutError extends Error {
  constructor() {
    super(
      `WhatsApp media download stalled: no data received for ${WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS}ms`,
    );
    this.name = "WhatsAppInboundMediaTimeoutError";
  }
}

async function* withChunkIdleTimeout(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: IteratorResult<unknown>;
      try {
        result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new WhatsAppInboundMediaTimeoutError()),
              WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    if (stream instanceof Readable) {
      stream.destroy();
    }
    // An arbitrary iterable can leave return() queued behind a stalled next().
    // Destroy Node sources first; observe return rejection without blocking fallback.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }
}

export async function saveInboundMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName?: string,
): Promise<SavedMedia> {
  const readable = stream instanceof Readable ? stream : undefined;
  const destroyPipedSource = (source: Readable) => {
    source.destroy();
  };
  // Baileys 7 pipes the HTTP body into a decrypting Transform. Destroying only
  // that Transform unpipes, but does not destroy, its HTTP source. The public
  // unpipe event supplies that source even though Baileys returns only the sink.
  if (readable && !readable.closed) {
    readable.on("unpipe", destroyPipedSource);
    readable.once("close", () => readable.off("unpipe", destroyPipedSource));
  }
  try {
    return await saveMediaStream(
      withChunkIdleTimeout(stream),
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );
  } finally {
    // Also release sources when store setup fails before iteration starts.
    readable?.destroy();
  }
}
