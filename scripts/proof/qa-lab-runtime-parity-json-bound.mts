// Real behavior proof: QA-lab runtime-parity mock debug endpoint does not
// buffer an oversized JSON body.
//
// A local HTTP server returns a 20 MiB JSON-like payload. The script routes the
// mocked global fetch to that server, then calls loadRuntimeParityMockToolCalls.
// With the bounded readProviderJsonResponse helper the oversized body is caught
// and the function returns null instead of forcing the runtime to allocate the
// whole payload.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { __testing } = await import(
  path.join(repoRoot, "extensions/qa-lab/src/runtime-parity.js")
);

const OVERSIZED_BYTES = 20 * 1024 * 1024;
const MOCK_BASE_URL = "http://127.0.0.1:9999";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(`[${"x".repeat(OVERSIZED_BYTES)}]`);
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

console.log("=== Proof: qa-lab runtime-parity JSON bound ===\n");
console.log(`Local server returning ${OVERSIZED_BYTES} bytes at ${localUrl}`);

try {
  const result = await __testing.loadRuntimeParityMockToolCalls(
    MOCK_BASE_URL,
    "parent prompt",
  );
  if (result === null) {
    console.log("\nPASS: oversized mock debug response was discarded (returned null).");
  } else {
    console.log("\nFAIL: expected null but got a result.");
    process.exitCode = 1;
  }
} catch (error) {
  console.log("\nFAIL: loadRuntimeParityMockToolCalls threw an unexpected error:");
  console.log(error);
  process.exitCode = 1;
} finally {
  server.close();
}
