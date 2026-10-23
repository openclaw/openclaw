// Synthetic Gateway entry for attributing main-thread synchronous fsync calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

assert.ok(process.env.OPENCLAW_STATE_DIR, "An isolated team-shape fixture is required");
assert.ok(
  fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "team-shape-summary.json")),
  "Run only against generated team-shape fixtures",
);
if (isMainThread) {
  Error.stackTraceLimit = 40;
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const stack = new Error("main-thread-fsync").stack;
    const started = performance.now();
    try {
      return original(fd);
    } finally {
      process.stderr.write(
        `FSYNC_PROBE ${JSON.stringify({ at: Date.now(), ms: performance.now() - started, stack })}\n`,
      );
    }
  };
  syncBuiltinESMExports();
}
process.argv[1] = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
await import("../../src/entry.ts");
