/**
 * Live proof for #103578: the full refreshAccessToken → postTokenForm →
 * readResponseWithLimit → extractProviderErrorDetail chain bounds oversized
 * error bodies and redacts secrets from normal-sized error responses.
 *
 * Starts a loopback server.  Redirects postTokenForm via
 * OPENCLAW_OAUTH_PROOF_TOKEN_URL.  Calls the production refreshAccessToken
 * function to exercise the full chain.
 *
 * Usage: node --import tsx scripts/proof/openai-oauth-refresh-live.mts
 */
import { createServer, type Server } from "node:http";

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Failed to get server port"));
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

async function runCase(label: string, body: string, checks: (msg: string) => boolean) {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(body);
  });
  const port = await listenLoopback(server);
  process.env.OPENCLAW_OAUTH_PROOF_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`;

  const { testing } = await import("../../extensions/openai/openai-chatgpt-oauth-flow.runtime.js");

  try {
    const result = await testing.refreshAccessToken("old-refresh-token", {
      timeoutMs: 5000,
    });
    const ok =
      result.type === "failed" && checks((result as { type: "failed"; message: string }).message);
    console.log(`${label}: ${ok ? "PASS" : "FAIL"}`);
    return ok;
  } finally {
    await closeServer(server);
    delete process.env.OPENCLAW_OAUTH_PROOF_TOKEN_URL;
  }
}

let allPassed = true;
console.log("=== #103578 live OAuth bounded-error proof ===\n");

// Case 1 — normal-sized error with credential is redacted.
const secret = "oauth-refresh-secret-abc123";
const smallBody = JSON.stringify({
  error: "invalid_grant",
  error_description: `Token refresh failed for refresh_token=${secret}`,
});
const ok1 = await runCase(
  "Case 1 — secret redacted from normal error body",
  smallBody,
  (msg) => msg.includes("invalid_grant") && !msg.includes(secret),
);
if (!ok1) allPassed = false;

// Case 2 — oversized error body is bounded (rejected before buffering).
const bigBody = JSON.stringify({ error: "server_error" }) + "x".repeat(20 * 1024);
const ok2 = await runCase(
  "Case 2 — oversized body bounded (rejected)",
  bigBody,
  (msg) => msg.includes("too large") || msg.includes("16384"),
);
if (!ok2) allPassed = false;

console.log(`\nOVERALL: ${allPassed ? "ALL PASSED" : "FAILURES"}`);
process.exit(allPassed ? 0 : 1);
