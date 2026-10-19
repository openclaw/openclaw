import crypto from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { FILE_FETCH_CHUNK_BYTES } from "../shared/file-fetch-protocol.js";

/** Stream the already authorized handle; START and ACK bound receiver-side buffering. */
export async function streamFetchedFile(
  handle: FileHandle,
  maxBytes: number,
  io: OpenClawPluginNodeHostCommandIo,
): Promise<{ size: number; sha256: string }> {
  const frames = io.frames;
  if (!frames) {
    throw new Error("binary file.fetch requires framed duplex IO");
  }
  io.signal.throwIfAborted();
  let expected: "start" | "ack" | undefined = "start";
  let receipt = createDeferred<void>();
  void receipt.promise.catch(() => {});
  const onAbort = () => receipt.reject(io.signal.reason);
  io.signal.addEventListener("abort", onAbort, { once: true });
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = frames.onMessage((message) => {
      if (!expected || Buffer.from(message).toString("utf8") !== expected) {
        const error = new Error("Unexpected file.fetch stream control");
        receipt.reject(error);
        throw error;
      }
      expected = undefined;
      receipt.resolve();
    });
    // Readiness is sent by onMessage. Do not send bytes until the caller subscribes.
    io.signal.throwIfAborted();
    await receipt.promise;
    const chunk = Buffer.allocUnsafe(FILE_FETCH_CHUNK_BYTES);
    const hash = crypto.createHash("sha256");
    let size = 0;
    while (true) {
      io.signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, maxBytes - size + 1),
      );
      io.signal.throwIfAborted();
      if (!bytesRead) {
        return { size, sha256: hash.digest("hex") };
      }
      size += bytesRead;
      if (size > maxBytes) {
        throw Object.assign(new Error("file grew beyond the authorized byte limit"), {
          code: "FILE_TOO_LARGE",
        });
      }
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      receipt = createDeferred<void>();
      // Observe rejection if abort happens while send is still pending.
      void receipt.promise.catch(() => {});
      expected = "ack";
      await frames.send(bytes);
      await receipt.promise;
    }
  } finally {
    unsubscribe?.();
    io.signal.removeEventListener("abort", onAbort);
  }
}
