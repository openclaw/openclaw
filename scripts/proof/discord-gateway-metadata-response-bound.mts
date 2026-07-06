// Real behavior proof: Discord gateway metadata fetch rejects an oversized
// response body instead of buffering it unbounded.
//
// A local HTTP server returns a 20 MiB payload. The script routes the mocked
// global fetch for the Discord metadata URL to that server, then calls
// fetchDiscordGatewayMetadataGuarded. The bounded read in materializeGuardedResponse
// rejects before the full body is consumed.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { fetchDiscordGatewayMetadataGuarded } = await import(
  path.join(repoRoot, "extensions/discord/src/monitor/gateway-metadata.js")
);

const OVERSIZED_BYTES = 20 * 1024 * 1024;
const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";

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
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === DISCORD_GATEWAY_BOT_URL) {
      return originalFetch(localUrl);
    }
    return originalFetch(input, init);
  },
  { mock: {} },
);

console.log("=== Proof: discord gateway metadata response bound ===\n");
console.log(`Local server returning ${OVERSIZED_BYTES} bytes at ${localUrl}`);

try {
  await fetchDiscordGatewayMetadataGuarded(DISCORD_GATEWAY_BOT_URL);
  console.log("\nFAIL: fetchDiscordGatewayMetadataGuarded did not reject.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\nCaught expected error: ${message}`);
  if (message.includes("Discord gateway metadata response exceeds")) {
    console.log("\nPASS: oversized response was rejected before OOM.");
  } else {
    console.log("\nFAIL: error did not mention the response size bound.");
    process.exitCode = 1;
  }
} finally {
  server.close();
}
