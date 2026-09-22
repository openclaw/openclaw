import crypto from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";

/** Send bounded messages over the existing paired-node stream, never inline JSON bytes. */
export async function createWorkspaceFile(options: {
  openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>;
  nodeId: string;
  path: string;
  data: Buffer;
  mkdir: boolean;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ result: unknown; sha256: string }> {
  options.assertCurrent();
  const sha256 = crypto.createHash("sha256").update(options.data).digest("hex");
  const channel = await options.openDuplex({
    nodeId: options.nodeId,
    command: "file.create",
    params: {
      path: options.path,
      sizeBytes: options.data.byteLength,
      maxBytes: Math.max(1, options.data.byteLength),
      expectedSha256: sha256,
      createParents: options.mkdir,
      followSymlinks: false,
    },
    maxMessageBytes: 1024 * 1024,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    timeoutMs: 60_000,
  });
  // Observe closure even if the next authority check or send throws first.
  void channel.closed.catch(() => {});
  let unsubscribe: (() => void) | undefined;
  try {
    options.assertCurrent();
    let receipt = createDeferred<void>();
    let awaiting = false;
    unsubscribe = channel.onMessage((message) => {
      options.assertCurrent();
      if (!awaiting || Buffer.from(message).toString("utf8") !== "ack") {
        throw new Error("Unexpected file.create acknowledgement");
      }
      awaiting = false;
      receipt.resolve();
    });
    for (let offset = 0; offset < options.data.byteLength; offset += 1024 * 1024) {
      options.assertCurrent();
      receipt = createDeferred<void>();
      awaiting = true;
      await channel.send(options.data.subarray(offset, offset + 1024 * 1024));
      // Sending frames does not await the node's receiver; one ACK bounds queued bytes.
      await Promise.race([
        receipt.promise,
        channel.closed.then(() => {
          throw new Error("File upload closed before acknowledgement");
        }),
      ]);
    }
    options.assertCurrent();
    await channel.send(new Uint8Array());
    const result = await channel.closed;
    options.assertCurrent();
    return { result, sha256 };
  } finally {
    unsubscribe?.();
    channel.close();
  }
}
