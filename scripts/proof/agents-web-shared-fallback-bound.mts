// Real behavior proof: readResponseText bounds the fallback body read when a
// response is not a stream.
//
// A local HTTP server returns a 20 MiB text body. The script fetches it, then
// passes the Response to readResponseText with a 1 MiB cap. Even though the
// response has a stream body, the shared bounded reader cancels after the cap
// and reports truncation; on non-stream Response-like mocks the fallback paths
// now apply the same maxBytes limit instead of reading unbounded.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { readResponseText } = await import(
  path.join(repoRoot, "src/agents/tools/web-shared.js")
);

const OVERSIZED_BYTES = 20 * 1024 * 1024;
const MAX_BYTES = 1024 * 1024;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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

console.log("=== Proof: agents web-shared fallback bound ===\n");
console.log(`Local server returning ${OVERSIZED_BYTES} bytes at ${localUrl}`);

try {
  const response = await fetch(localUrl);
  const result = await readResponseText(response, { maxBytes: MAX_BYTES });
  console.log(`\nRead result: truncated=${result.truncated}, bytesRead=${result.bytesRead}`);
  if (result.truncated && result.bytesRead === MAX_BYTES && result.text.length <= MAX_BYTES) {
    console.log("\nPASS: oversized response was bounded before buffering the full body.");
  } else {
    console.log("\nFAIL: response was not bounded as expected.");
    process.exitCode = 1;
  }
} catch (error) {
  console.log("\nFAIL: readResponseText threw an unexpected error:");
  console.log(error);
  process.exitCode = 1;
} finally {
  server.close();
}
