// IPC observer for the synthetic Gateway started by browser-protocol-retention.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const sources: Array<{ path: string; sha256?: string }> = [];
  const inspector = new Session();
  inspector.connect();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (!/\/pw-(session-state|tools-core\.interactions\.content)\.ts(?:[?#]|$)/u.test(params.url)) {
      return;
    }
    const sourcePath = params.url.startsWith("file:") ? fileURLToPath(params.url) : params.url;
    sources.push({
      path: sourcePath,
      sha256: existsSync(sourcePath)
        ? createHash("sha256").update(readFileSync(sourcePath)).digest("hex")
        : undefined,
    });
  });
  await inspector.post("Debugger.enable");
  let observing = true;
  const capture = async (message: { channel?: string; id?: string; filename?: string }) => {
    if (message.channel !== "browser-protocol-retention") {
      return;
    }
    try {
      if (observing) {
        await inspector.post("Debugger.disable");
        inspector.disconnect();
        observing = false;
      }
      assert(globalThis.gc && message.filename);
      globalThis.gc();
      const memory = process.memoryUsage();
      writeHeapSnapshot(message.filename);
      process.send?.({ channel: message.channel, id: message.id, memory, sources });
    } catch (error) {
      process.send?.({ channel: message.channel, id: message.id, error: String(error) });
    }
  };
  process.on("message", (message) => {
    void capture(message);
  });
  process.channel?.unref();
}
