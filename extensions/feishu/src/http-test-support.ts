import { once } from "node:events";
import type { ServerResponse } from "node:http";

export function writeOversizedJson(
  response: ServerResponse,
  totalBytes: number,
  params: { prefix: string; signal: AbortSignal },
) {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesPulled = 0;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const abort = () => response.destroy();
  const sendChunk = () => {
    if (response.destroyed) {
      return;
    }
    if (bytesPulled >= totalBytes) {
      response.end('"}');
      return;
    }
    const size = Math.min(chunk.byteLength, totalBytes - bytesPulled);
    bytesPulled += size;
    if (response.write(chunk.subarray(0, size))) {
      scheduled = setImmediate(sendChunk);
    } else {
      response.once("drain", sendChunk);
    }
  };
  // Abort is a failed observation; forced teardown must never count as an early close.
  const closed = once(response, "close", { signal: params.signal })
    .then(
      () => ({ completed: response.writableEnded }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      clearImmediate(scheduled);
      response.off("drain", sendChunk);
      params.signal.removeEventListener("abort", abort);
    });
  params.signal.addEventListener("abort", abort, { once: true });
  if (params.signal.aborted) {
    abort();
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    const prefix = Buffer.from(params.prefix);
    bytesPulled += prefix.byteLength;
    response.write(prefix);
    scheduled = setImmediate(sendChunk);
  }
  return { bytesPulled: () => bytesPulled, closed };
}
