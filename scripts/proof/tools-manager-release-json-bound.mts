// Real behavior proof: tools-manager bounds the GitHub release JSON read.
//
// getLatestVersion previously called response.json(), which buffers the entire
// body before parsing. After the fix it uses readProviderJsonResponse with a
// 1 MiB cap. This proof starts a local HTTP server returning a release JSON
// body larger than that cap and shows readProviderJsonResponse rejects before
// the runtime buffers it all. A second call with a small valid body parses
// normally.

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { readProviderJsonResponse } = await import(
  path.join(repoRoot, "src/agents/provider-http-errors.js")
);

const PORT = 0;
const HUGE_SIZE = 8 * 1024 * 1024;
let sendOversized = false;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  if (sendOversized) {
    res.write('{"tag_name":"v99.0.0","body":"');
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    function sendChunk(): void {
      if (sent >= HUGE_SIZE) {
        res.end('"}');
        return;
      }
      res.write(chunk);
      sent += chunk.length;
      setImmediate(sendChunk);
    }
    sendChunk();
  } else {
    res.end(JSON.stringify({ tag_name: "v10.2.0", body: "normal release notes" }));
  }
});

await new Promise<void>((resolve) => {
  server.listen(PORT, "127.0.0.1", () => {
    resolve();
  });
});
const address = server.address();
const port = address && typeof address === "object" ? address.port : 0;

console.log("=== Proof: tools-manager release JSON bound ===\n");
console.log(`Local server listening on port ${port}\n`);

// Normal path: small body parses fine.
const normalUrl = `http://127.0.0.1:${port}/normal`;
const normalResp = await fetch(normalUrl);
const normalData = await readProviderJsonResponse<{ tag_name: string }>(
  normalResp,
  "GitHub release check",
  { maxBytes: 1024 * 1024 },
);
console.log(`Normal response tag_name: ${normalData.tag_name}`);

// Oversized path: bounded read rejects before buffering everything.
sendOversized = true;
const oversizedUrl = `http://127.0.0.1:${port}/oversized`;
const oversizedResp = await fetch(oversizedUrl);
const startMem = process.memoryUsage.rss();
const start = performance.now();

try {
  await readProviderJsonResponse<{ tag_name: string }>(
    oversizedResp,
    "GitHub release check",
    { maxBytes: 1024 * 1024 },
  );
  console.log("\nFAIL: oversized body should have been rejected.");
  process.exitCode = 1;
} catch (err) {
  const duration = performance.now() - start;
  const endMem = process.memoryUsage.rss();
  const message = err instanceof Error ? err.message : String(err);
  console.log(`\nOversized body rejected: ${message}`);
  console.log(`Duration: ${duration.toFixed(1)} ms`);
  console.log(`RSS delta: ${((endMem - startMem) / 1024 / 1024).toFixed(1)} MB`);

  if (message.includes("JSON response exceeds") && duration < 5000 && endMem - startMem < 64 * 1024 * 1024) {
    console.log("\nPASS: release JSON read is bounded; oversized bodies fail fast without OOM.");
  } else {
    console.log("\nFAIL: did not fail fast or consumed too much memory.");
    process.exitCode = 1;
  }
} finally {
  server.close();
  await new Promise<void>((resolve) => {
    server.once("close", () => {
      resolve();
    });
  });
}
