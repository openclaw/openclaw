import type { IncomingMessage } from "node:http";

const MAX_UPGRADE_ERROR_BODY_BYTES = 2 * 1024;
const UPGRADE_ERROR_BODY_TIMEOUT_MS = 1_000;

export async function readUpgradeErrorBody(response: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.off("data", onData);
      response.off("end", finish);
      response.off("error", finish);
      response.off("aborted", finish);
      resolve(Buffer.concat(chunks, totalBytes).toString("utf8").replace(/\s+/gu, " ").trim());
    };
    const stop = () => {
      finish();
      response.destroy();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_UPGRADE_ERROR_BODY_BYTES - totalBytes;
      if (remaining > 0) {
        const prefix = buffer.subarray(0, remaining);
        chunks.push(prefix);
        totalBytes += prefix.byteLength;
      }
      if (buffer.byteLength >= remaining) {
        stop();
      }
    };
    const timer = setTimeout(stop, UPGRADE_ERROR_BODY_TIMEOUT_MS);
    timer.unref?.();
    response.on("data", onData);
    response.once("end", finish);
    response.once("error", finish);
    response.once("aborted", finish);
  });
}
