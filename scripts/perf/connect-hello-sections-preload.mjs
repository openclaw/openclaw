/**
 * Synthetic dev Gateway attribution only. Pass to transcript-broadcast-measure.ts
 * --gateway-preload scripts/perf/connect-hello-sections-preload.mjs --scenario connect
 * --diagnostics --prep-trace. Writes hello-sections.jsonl in OPENCLAW_STATE_DIR.
 * Captures section byte counts and serialization times, never field contents.
 * Additional section serialization and file IO perturb connect latency: use this
 * as a separate attribution pass, not an uninstrumented performance gate. Existing
 * Gateway debug logs provide auth/attach/snapshot/descriptor/send phase durations.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Hello attribution requires an isolated OPENCLAW_STATE_DIR");
  }
  const destination = path.join(stateDir, "hello-sections.jsonl");
  const stringify = JSON.stringify;
  JSON.stringify = function (value, replacer, space) {
    const hello = value?.type === "res" && value?.payload?.type === "hello-ok";
    const started = hello ? performance.now() : 0;
    const serialized = stringify(value, replacer, space);
    if (hello && typeof serialized === "string") {
      const serializeMs = performance.now() - started;
      const sections = {};
      for (const [key, section] of Object.entries(value.payload)) {
        const sectionStarted = performance.now();
        const text = stringify(section);
        sections[key] = {
          bytes: text === undefined ? 0 : Buffer.byteLength(text),
          serializeMs: performance.now() - sectionStarted,
        };
      }
      const snapshot = {};
      for (const [key, section] of Object.entries(value.payload.snapshot)) {
        const sectionStarted = performance.now();
        const text = stringify(section);
        snapshot[key] = {
          bytes: text === undefined ? 0 : Buffer.byteLength(text),
          serializeMs: performance.now() - sectionStarted,
        };
      }
      appendFileSync(
        destination,
        stringify({
          at: Date.now(),
          bytes: Buffer.byteLength(serialized),
          serializeMs,
          sections,
          snapshot,
        }) + "\n",
      );
    }
    return serialized;
  };
}
