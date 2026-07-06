// Real behavior proof: QA-lab web app fetchJson rejects an oversized JSON
// response instead of buffering it unbounded.
//
// A local HTTP server returns a 20 MiB JSON payload. The script monkeypatches
// global fetch to delegate to that server, then calls fetchJson. The bounded
// readProviderJsonResponse helper rejects before the full body is consumed.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { fetchJson } = await import(
  path.join(repoRoot, "extensions/qa-lab/web/src/app.js")
);

const OVERSIZED_BYTES = 20 * 1024 * 1024;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(`{"x":"${"x".repeat(OVERSIZED_BYTES)}"}`);
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
const localUrl =
  typeof address === "object" && address !== null
    ? `http://127.0.0.1:${address.port}`
    : null;
if (!localUrl) {
  throw new Error("Failed to start local server");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    originalFetch(localUrl),
  { mock: {} },
);

console.log("=== Proof: qa-lab web app JSON bound ===\n");
console.log(`Local server returning ${OVERSIZED_BYTES} bytes at ${localUrl}`);

try {
  await fetchJson("/api/test");
  console.log("\nFAIL: fetchJson did not reject.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nCaught expected error: ${message}`);
  if (message.includes("qa-lab web: JSON response exceeds")) {
    console.log("\nPASS: oversized JSON response was rejected before OOM.");
  } else {
    console.log("\nFAIL: error did not mention the JSON size bound.");
    process.exitCode = 1;
  }
} finally {
  server.close();
}
