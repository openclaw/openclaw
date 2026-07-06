// Real behavior proof: QA-lab credential admin endpoint rejects an oversized
// response body instead of buffering it unbounded.
//
// A local HTTP server returns a 20 MiB payload. The script passes a fetch
// implementation that delegates to that server into listQaCredentialSets, so the
// bounded read in postJson rejects before the full body is consumed.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const {
  listQaCredentialSets,
  QaCredentialAdminError,
} = await import(
  path.join(repoRoot, "extensions/qa-lab/src/qa-credentials-admin.runtime.js")
);

const OVERSIZED_BYTES = 20 * 1024 * 1024;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("x".repeat(OVERSIZED_BYTES));
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
const fetchImpl = async (): Promise<Response> => originalFetch(localUrl);

console.log("=== Proof: qa-lab credentials-admin response bound ===\n");
console.log(`Local server returning ${OVERSIZED_BYTES} bytes at ${localUrl}`);

try {
  await listQaCredentialSets({
    siteUrl: "https://first-schnauzer-821.convex.site",
    env: {
      OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
    },
    fetchImpl,
  });
  console.log("\nFAIL: listQaCredentialSets did not reject.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nCaught expected error: ${message}`);
  if (
    error instanceof QaCredentialAdminError &&
    error.code === "BROKER_REQUEST_FAILED" &&
    message.includes("Convex credential admin response exceeds")
  ) {
    console.log("\nPASS: oversized credential admin response was rejected before OOM.");
  } else {
    console.log("\nFAIL: error did not match the expected size-bound error.");
    process.exitCode = 1;
  }
} finally {
  server.close();
}
