/**
 * Proof for #103578: extractProviderErrorDetail bounds and redacts error
 * response bodies from a real loopback HTTP server.
 *
 * Usage: node --import tsx scripts/proof/openai-oauth-refresh-live.mts
 */
import { createServer, type Server } from "node:http";
import { extractProviderErrorDetail } from "../../src/plugin-sdk/provider-http.js";

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function runCase(
  label: string,
  body: string,
  checks: (detail: string | undefined) => boolean,
) {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(body);
  });
  const port = await listenLoopback(server);
  let ok = false;
  try {
    const response = await fetch("http://127.0.0.1:" + port);
    const detail = await extractProviderErrorDetail(response);
    ok = checks(detail);
  } finally {
    await closeServer(server);
  }
  console.log(label + ": " + (ok ? "PASS" : "FAIL"));
  return ok;
}

let allPassed = true;
console.log("=== #103578 bounded OAuth error proof ===\n");

// Case 1 - secret values in OAuth token response fields are redacted.
const secret = "oauth-refresh-secret-abc123";
const ok1 = await runCase(
  "Case 1 - secret redacted from error body",
  JSON.stringify({
    error: "invalid_grant",
    error_description: "Token refresh failed",
    refresh_token: secret,
    access_token: "sk-" + secret,
  }),
  (detail) =>
    typeof detail === "string" && detail.includes("invalid_grant") && !detail.includes(secret),
);
if (!ok1) {
  allPassed = false;
}

// Case 2 - oversized body is bounded.
const ok2 = await runCase(
  "Case 2 - oversized body bounded",
  JSON.stringify({ error: "server_error" }) + "x".repeat(64 * 1024),
  (detail) => typeof detail === "string" && detail.length < 16 * 1024,
);
if (!ok2) {
  allPassed = false;
}

// Case 3 - normal error body passes through.
const ok3 = await runCase(
  "Case 3 - normal body preserved",
  JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials" }),
  (detail) => typeof detail === "string" && detail.includes("invalid_client"),
);
if (!ok3) {
  allPassed = false;
}

console.log("\nOVERALL: " + (allPassed ? "ALL PASSED" : "FAILURES"));
process.exit(allPassed ? 0 : 1);