#!/usr/bin/env tsx
/**
 * Live behavior proof for PR #103206 (canonical responseHeaderTimeoutMs seam).
 *
 * Runs the actual `loadWebMedia` (the public web-media entrypoint that
 * image-tool.ts / image-generate-tool.ts / pdf-tool.ts invoke through
 * imageWebMedia.loadWebMedia, and the public Tlon extension calls through
 * readRemoteMediaBuffer / saveRemoteMedia) against a real stalled HTTP
 * server.
 *
 * This is a "live run" — not a test transcript:
 *   - Starts a real Node.js HTTP server that accepts the connection but
 *     never sends response headers (simulating a stalled remote endpoint).
 *   - Calls loadWebMedia with the canonical responseHeaderTimeoutMs seam
 *     (the same field the Tlon and agent-tool callers forward in this PR).
 *   - Captures and prints the surfaced error shape that propagates to
 *     the tool / extension caller.
 *
 * The demo uses a 1s header deadline so the script completes quickly; the
 * production code path uses 15 * 60_000. Same code path, only the timeout
 * value differs.
 *
 * Run: node node_modules/.bin/tsx /tmp/proof-103206-tool-run.mts
 */
import http from "node:http";
import { loadWebMedia } from "/media/vdc/OpenClaw/src/media/web-media.ts";

const RESPONSE_HEADER_TIMEOUT_MS = 1_000;
const startedAt = Date.now();

const server = http.createServer(() => {
  // Intentionally never call res.writeHead/end — withhold headers forever.
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const addr = server.address();
if (!addr || typeof addr === "string") {
  throw new Error("expected numeric port");
}
const port = addr.port;

const url = `http://127.0.0.1:${port}/never-responds.png`;
console.log(`[proof] stalled HTTP server listening on http://127.0.0.1:${port}`);
console.log(
  `[proof] calling loadWebMedia with responseHeaderTimeoutMs=${RESPONSE_HEADER_TIMEOUT_MS}ms (production code path uses 15*60_000)`,
);
console.log(`[proof] this exercises the canonical seam from PR #103020:`);
console.log(`[proof]   loadWebMedia -> readRemoteMediaBuffer -> fetchGuardedMediaResponse`);
console.log(`[proof]   -> fetchWithSsrFGuard -> buildTimeoutAbortSignal (response header deadline)`);
console.log(`[proof]   -> globalThis.fetch`);

let outcome: Record<string, unknown>;
try {
  await loadWebMedia(url, {
    maxBytes: 1024 * 1024,
    responseHeaderTimeoutMs: RESPONSE_HEADER_TIMEOUT_MS,
    readIdleTimeoutMs: 30_000,
    ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
  });
  outcome = { kind: "ok", elapsedMs: Date.now() - startedAt };
  console.log("[proof] UNEXPECTED: loadWebMedia resolved");
} catch (err) {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { name?: string; message?: string };
  };
  outcome = {
    kind: "error",
    name: e.name,
    code: e.code,
    message: e.message,
    causeName: e.cause?.name,
    causeMessage: e.cause?.message,
    elapsedMs: Date.now() - startedAt,
  };
} finally {
  server.close();
}

console.log(`[proof] elapsed: ${outcome.elapsedMs}ms`);
if (outcome.kind === "error") {
  console.log(`[proof] surfaced error.name: ${outcome.name}`);
  console.log(`[proof] surfaced error.code: ${outcome.code}`);
  console.log(`[proof] surfaced error.message: ${outcome.message}`);
  console.log(`[proof] surfaced error.cause.name: ${outcome.causeName}`);
  console.log(`[proof] surfaced error.cause.message: ${outcome.causeMessage}`);
  console.log(`[proof] result: responseHeaderTimeoutMs fired through real production path`);
}

const passed =
  outcome.kind === "error" &&
  outcome.code === "fetch_failed" &&
  outcome.causeName === "TimeoutError" &&
  typeof outcome.causeMessage === "string" &&
  /request timed out/i.test(outcome.causeMessage) &&
  typeof outcome.elapsedMs === "number" &&
  outcome.elapsedMs >= RESPONSE_HEADER_TIMEOUT_MS - 50 &&
  outcome.elapsedMs < RESPONSE_HEADER_TIMEOUT_MS + 5_000;

console.log(JSON.stringify({ url, responseHeaderTimeoutMs: RESPONSE_HEADER_TIMEOUT_MS, outcome, passed }, null, 2));
process.exit(passed ? 0 : 1);