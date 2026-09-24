import { getDefaultHighWaterMark } from "node:stream";
import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_UPLOADS = 16;
export const MAX_PENDING_REQUESTS = MAX_UPLOADS;

export function createUploadAdmission() {
  const permits = createPermitPool(MAX_UPLOADS);
  let outstanding = 0;
  let queuedBytes = 0;
  return async (signal: AbortSignal, deadlineAtMs: number, bytes = 0) => {
    const queued = outstanding >= MAX_UPLOADS;
    if (
      outstanding >= MAX_UPLOADS + MAX_PENDING_REQUESTS ||
      (queued && queuedBytes + bytes > MAX_BODY_BYTES)
    ) {
      return null;
    }
    // Count free-but-unresolved grants too, so one synchronous burst gets both
    // the active batch and the waiting batch instead of rejecting its 17th call.
    outstanding++;
    if (queued) {
      queuedBytes += bytes;
    }
    const releasePermit = await permits.acquire({ signal, deadlineAtMs });
    if (queued) {
      queuedBytes -= bytes;
    }
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      outstanding--;
      releasePermit?.();
    };
    if (!releasePermit || signal.aborted) {
      release();
      return null;
    }
    return release;
  };
}

export function createUploadBody(bytes: Buffer, signal: AbortSignal, release: () => void) {
  const length = bytes.length;
  const chunkSize = getDefaultHighWaterMark(false);
  let remaining: Buffer | undefined = bytes;
  let offset = 0;
  const settle = () => {
    remaining = undefined;
    signal.removeEventListener("abort", settle);
    release();
  };
  signal.addEventListener("abort", settle, { once: true });
  if (signal.aborted) {
    settle();
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        signal.throwIfAborted();
        if (!remaining || offset === length) {
          // With HWM 0, Undici's next pull follows the final chunk's drain-aware
          // write. Drop the backing body here, not when early response headers arrive.
          settle();
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, length);
        // A slice would retain the entire request while the transport owns a chunk.
        controller.enqueue(Uint8Array.from(remaining.subarray(offset, end)));
        offset = end;
      },
      cancel: settle,
    },
    { highWaterMark: 0 },
  );
  return { body, length, settle };
}
