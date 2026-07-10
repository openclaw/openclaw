#!/usr/bin/env node
// Loopback proof for PR #103306:
//   fix(google): bound embedding batch file upload error body read
//
// Exercises assertOkOrThrowProviderError (the exact helper used in the fix)
// against a real local HTTP server that returns an oversized streaming 503
// response, proving the non-OK file-upload error body is bounded at 16 KiB.
//
// Usage: node --import tsx scripts/proof/gemini-file-upload-error-loopback.mjs

import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// Phase 1: start a local HTTP server
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 64 * 1024; // 64 KiB per chunk
const CHUNK_COUNT = 64; // 4 MiB total — 256x the 16 KiB cap
const BOUND = 16 * 1024;
let serverChunksSent = 0;
let bodySizeSent = 0;

const server = createServer((req, res) => {
  const url = req.url ?? "";

  if (url === "/upload") {
    // Return 503 with an oversized streaming JSON body.
    res.writeHead(503, { "Content-Type": "application/json" });
    res.write('{"error":{"code":503,"message":"Service Unavailable","details":"');
    const padding = "x".repeat(CHUNK_SIZE);
    function writeNext() {
      if (serverChunksSent >= CHUNK_COUNT) {
        res.end('"}}');
        return;
      }
      serverChunksSent += 1;
      bodySizeSent += padding.length;
      if (!res.write(padding)) {
        res.once("drain", writeNext);
      } else {
        setImmediate(writeNext);
      }
    }
    writeNext();
    return;
  }

  res.writeHead(500);
  res.end("unexpected");
});

await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => resolve());
  server.once("error", reject);
});
const PORT = server.address().port;
console.error(`[server] listening on http://127.0.0.1:${PORT}`);

// ---------------------------------------------------------------------------
// Phase 2: exercise assertOkOrThrowProviderError against the real server
// ---------------------------------------------------------------------------

const { assertOkOrThrowProviderError } = await import("../../src/agents/provider-http-errors.js");

console.error("[proof] fetching oversized 503 response from local server …");
const startMs = Date.now();
const response = await fetch(`http://127.0.0.1:${PORT}/upload`);

console.error(`[proof] response status: ${response.status}`);
console.error("[proof] calling assertOkOrThrowProviderError …");

try {
  await assertOkOrThrowProviderError(response, "gemini.batch-file-upload");
  console.error("[proof] UNEXPECTED: did not throw");
  process.exit(1);
} catch (err) {
  const elapsed = Date.now() - startMs;
  const name = err instanceof Error ? err.constructor.name : "unknown";
  const message = err instanceof Error ? err.message : String(err);

  console.error(`[proof] rejected in ${elapsed} ms`);
  console.error(`[proof] error type: ${name}`);

  if (name !== "ProviderHttpError") {
    console.error(`[proof] ❌ expected ProviderHttpError, got ${name}`);
    process.exit(1);
  }
  console.error("[proof] ✅ ProviderHttpError — bounded structured error");
  console.error(`[proof]    statusCode: ${err.statusCode}`);

  const bodyPreview = err.errorBody ?? "";
  console.error(`[proof]    errorBody length: ${bodyPreview.length} bytes`);

  if (!bodyPreview) {
    console.error("[proof] ❌ errorBody is empty");
    process.exit(1);
  }

  if (bodyPreview.length > BOUND) {
    console.error(`[proof] ❌ errorBody UNBOUNDED: ${bodyPreview.length} > ${BOUND}`);
    process.exit(1);
  }
  console.error(`[proof] ✅ errorBody bounded (≤ ${BOUND} byte cap)`);

  if (message.length > BOUND * 2) {
    console.error(`[proof] ❌ error message too large: ${message.length} bytes`);
    process.exit(1);
  }
  console.error(`[proof] ✅ error message bounded (${message.length} bytes)`);
}

server.close();

// ---------------------------------------------------------------------------
// Phase 3: redacted output for PR body
// ---------------------------------------------------------------------------

console.log("\n--- redacted loopback proof output (for PR body) ---");
console.log("$ node --import tsx scripts/proof/gemini-file-upload-error-loopback.mjs");
console.log();
console.log(`// Server sends 503 with ~4 MiB streaming JSON body.`);
console.log(`// assertOkOrThrowProviderError reads at most ${BOUND} bytes.`);
console.log(`// Error type: ProviderHttpError`);
console.log(`// statusCode: 503`);
console.log(
  `// errorBody: bounded (server sent ${serverChunksSent} chunks, ${(bodySizeSent / (1024 * 1024)).toFixed(1)} MiB)`,
);
console.log();
console.log("✅ Bounded: error body capped at 16 KiB despite 4 MiB server response.");
console.error("[proof] done — all checks passed");
