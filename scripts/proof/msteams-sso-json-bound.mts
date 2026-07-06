// Real behavior proof: MSTeams SSO token exchange bounds the User Token
// service JSON response so an oversized body cannot OOM the runtime.
//
// The proof runs a local HTTP server that returns a User Token response
// larger than the 64 KiB cap. With the fix the handler rejects with an
// "invalid JSON" service error; without the bound the runtime would buffer
// the entire oversized body before parsing.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleSigninTokenExchangeInvoke } from "../../extensions/msteams/src/sso.js";

const hugeBody = JSON.stringify({
  channelId: "msteams",
  connectionName: "GraphConnection",
  token: "delegated-graph-token",
  expiration: "2030-01-01T00:00:00Z",
  padding: "x".repeat(128 * 1024),
});

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(hugeBody);
});

await new Promise<void>((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => {
    resolve();
  });
  server.on("error", reject);
});
const { port } = server.address() as AddressInfo;

console.log("=== Proof: MSTeams SSO JSON response bound ===\n");

try {
  const result = await handleSigninTokenExchangeInvoke({
    value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
    user: { userId: "aad-user-guid", channelId: "msteams" },
    deps: {
      userTokenBaseUrl: `http://127.0.0.1:${port}`,
      connectionName: "GraphConnection",
      tokenProvider: {
        getAccessToken: async () => "bf-service-token",
      },
      tokenStore: {
        async get() {
          return null;
        },
        async save() {},
        async remove() {
          return true;
        },
      },
    },
  });

  if (!result.ok && result.code === "unexpected_response" && /invalid JSON/i.test(result.message)) {
    console.log("PASS: oversized User Token JSON response was rejected without OOM.");
  } else {
    console.log("FAIL: unexpected result:", result);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("FAIL: handler threw:", err);
  process.exitCode = 1;
} finally {
  server.close();
}
