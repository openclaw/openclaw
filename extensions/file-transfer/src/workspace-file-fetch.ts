import crypto from "node:crypto";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { throwFromNodePayload } from "./shared/errors.js";
import { FILE_FETCH_CHUNK_BYTES } from "./shared/file-fetch-protocol.js";

/** Receive a bounded binary fetch through the same policy-owned file.fetch command. */
export async function fetchWorkspaceFile(options: {
  openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>;
  nodeId: string;
  params: Record<string, unknown>;
  maxBytes: number;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ data: Buffer; canonicalPath: string }> {
  options.assertCurrent();
  const channel = await options.openDuplex({
    nodeId: options.nodeId,
    command: "file.fetch",
    params: { ...options.params, transport: "binary", maxBytes: options.maxBytes },
    maxMessageBytes: FILE_FETCH_CHUNK_BYTES,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    timeoutMs: 60_000,
  });
  void channel.closed.catch(() => {});
  let unsubscribe: (() => void) | undefined;
  try {
    options.assertCurrent();
    const chunks: Buffer[] = [];
    const hash = crypto.createHash("sha256");
    let size = 0;
    unsubscribe = channel.onMessage(async (message) => {
      options.assertCurrent();
      if (
        !message.byteLength ||
        message.byteLength > FILE_FETCH_CHUNK_BYTES ||
        message.byteLength > options.maxBytes - size
      ) {
        throw new Error("Invalid or oversized binary file.fetch payload");
      }
      const chunk = Buffer.from(message);
      size += chunk.byteLength;
      hash.update(chunk);
      chunks.push(chunk);
      await channel.send(Buffer.from("ack"));
      options.assertCurrent();
    });
    await channel.send(Buffer.from("start"));
    const result = asOptionalRecord(await channel.closed);
    options.assertCurrent();
    const payload = asOptionalRecord(result?.payload);
    if (!payload || payload.ok !== true) {
      throwFromNodePayload("file.fetch", payload ?? {});
    }
    if (
      payload.transport !== "binary" ||
      typeof payload.path !== "string" ||
      payload.size !== size ||
      payload.sha256 !== hash.digest("hex")
    ) {
      throw new Error("Binary file.fetch receipt does not match the received bytes");
    }
    return { data: Buffer.concat(chunks, size), canonicalPath: payload.path };
  } finally {
    unsubscribe?.();
    channel.close();
  }
}
