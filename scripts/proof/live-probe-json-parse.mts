// Real behavior proof: malformed MCP loopback JSON-RPC response handling.
// Starts a local HTTP server that returns invalid JSON on /mcp, then runs
// OpenClaw's live-probe helper against it and captures the contextual error.

import { createServer } from "node:http";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  setActiveMcpLoopbackRuntime,
} from "../../src/gateway/mcp-http.loopback-runtime.js";
import { verifyCliCronMcpLoopbackPreflight } from "../../src/gateway/gateway-cli-backend.live-probe-helpers.js";

const ownerToken = "proof-owner-token";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("not valid json {");
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("server did not bind to a TCP port");
}

setActiveMcpLoopbackRuntime({
  port: address.port,
  ownerToken,
  nonOwnerToken: "proof-non-owner-token",
});

console.log("=== Proof: live-probe helpers JSON.parse hardening ===\n");
console.log(`Loopback endpoint: http://127.0.0.1:${address.port}/mcp`);
console.log("Response body: not valid json {\n");

try {
  await verifyCliCronMcpLoopbackPreflight({
    sessionKey: "proof-session-key",
    port: address.port,
    token: "proof-gateway-token",
    env: {},
  });
  console.log("FAIL: expected verifyCliCronMcpLoopbackPreflight to throw");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("mcp loopback returned malformed JSON")) {
    console.log(`Caught expected error: ${message}`);
    console.log("\nPASS: malformed loopback JSON produces contextual error.");
  } else {
    console.log(`FAIL: unexpected error: ${message}`);
    process.exitCode = 1;
  }
} finally {
  clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
  server.close();
}
