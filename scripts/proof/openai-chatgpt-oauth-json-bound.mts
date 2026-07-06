// Real behavior proof: OpenAI ChatGPT OAuth token response read is bounded.
//
// exchangeAuthorizationCode and refreshAccessToken previously buffered the entire
// response body with response.json(). The fix uses readProviderJsonResponse with
// a 1 MiB cap so a runaway token endpoint cannot OOM the CLI login flow.
//
// This proof starts a local HTTP server, feeds it an oversized JSON body, and
// shows readProviderJsonResponse rejects before buffering the whole payload.

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { readProviderJsonResponse } = await import(
  path.join(repoRoot, "src/plugin-sdk/provider-http.js")
);

const PORT = 0;
const HUGE_SIZE = 8 * 1024 * 1024;
let sendOversized = false;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  if (sendOversized) {
    res.write('{"access_token":"a","refresh_token":"r","expires_in":3600,"padding":"');
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
    res.end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }));
  }
});

await new Promise<void>((resolve) => {
  server.listen(PORT, "127.0.0.1", () => {
    resolve();
  });
});
const address = server.address();
const port = address && typeof address === "object" ? address.port : 0;

console.log("=== Proof: OpenAI ChatGPT OAuth token JSON bound ===\n");
console.log(`Local token server listening on port ${port}\n`);

// Normal path: small token JSON parses fine.
const normalResp = await fetch(`http://127.0.0.1:${port}/token`);
const normalData = await readProviderJsonResponse<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}>(normalResp, "OpenAI Codex token exchange", { maxBytes: 1024 * 1024 });
console.log(`Normal token response: access_token=${normalData.access_token.slice(0, 8)}...`);

// Oversized path: bounded read rejects before buffering everything.
sendOversized = true;
const oversizedResp = await fetch(`http://127.0.0.1:${port}/token-oversized`);
const startMem = process.memoryUsage.rss();
const start = performance.now();

try {
  await readProviderJsonResponse<Record<string, unknown>>(
    oversizedResp,
    "OpenAI Codex token exchange",
    { maxBytes: 1024 * 1024 },
  );
  console.log("\nFAIL: oversized token body should have been rejected.");
  process.exitCode = 1;
} catch (err) {
  const duration = performance.now() - start;
  const endMem = process.memoryUsage.rss();
  const message = err instanceof Error ? err.message : String(err);
  console.log(`\nOversized token body rejected: ${message}`);
  console.log(`Duration: ${duration.toFixed(1)} ms`);
  console.log(`RSS delta: ${((endMem - startMem) / 1024 / 1024).toFixed(1)} MB`);

  if (message.includes("JSON response exceeds") && duration < 5000 && endMem - startMem < 64 * 1024 * 1024) {
    console.log("\nPASS: OAuth token JSON read is bounded; oversized bodies fail fast without OOM.");
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
