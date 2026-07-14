/**
 * Real behavior proof: qa-channel bus-state fetch timeout.
 *
 * Proves that getQaBusState (production entry point) rejects with a
 * TimeoutError when the loopback qa-bus peer accepts TCP but never
 * returns HTTP headers — rather than hanging forever.
 *
 * Covers:
 * - Negative control: fetchWithSsrFGuard with no timeoutMs hangs
 * - Positive control: getQaBusState with QA_BUS_STATE_TIMEOUT_MS rejects
 * - Valid response: normal server still works with the timeout configured
 */
import { createServer, type Server } from "node:http";
import { fetchWithSsrFGuard } from "./src/plugin-sdk/ssrf-runtime.js";
import { getQaBusState, QA_BUS_STATE_TIMEOUT_MS } from "./extensions/qa-channel/src/bus-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) { passed++; console.log("  ok: %s", description); }
    else { failed++; console.log("  FAIL: %s", description); }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server failed to bind");
  return addr.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Shared: hung peer that accepts TCP but never sends HTTP headers
// ---------------------------------------------------------------------------
const hungServer = createServer((_req, _res) => {
  // Accept TCP, never write headers → body idle caps never start.
});
const hungPort = await listenLoopback(hungServer);
const hungBaseUrl = `http://127.0.0.1:${hungPort}`;

console.log("Hung loopback peer on %s (accepts TCP, never responds)", hungBaseUrl);

// ---------------------------------------------------------------------------
// [case 1] Negative control — fetchWithSsrFGuard with no timeoutMs hangs
// ---------------------------------------------------------------------------
console.log("\n[case 1] negative control — no timeoutMs stays pending");
{
  const startedAt = Date.now();
  const hung = fetchWithSsrFGuard({
    url: `${hungBaseUrl}/v1/state`,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-channel.bus-state.proof-neg-control",
  });
  const outcome = await Promise.race([
    hung.then(() => "resolved" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 250);
    }),
  ]);
  const elapsedMs = Date.now() - startedAt;

  assert("no-timeoutMs fetch stays pending after 250ms", () => outcome === "still-pending");
  console.log("  info: outcome=%s elapsed_ms=%d without_timeoutMs=true", outcome, elapsedMs);
  // Tear down for the next case — close connections that the hung fetch holds.
  hungServer.closeAllConnections?.();
}

// ---------------------------------------------------------------------------
// [case 2] Positive control — getQaBusState times out against hung peer
// ---------------------------------------------------------------------------
// Restart a fresh hung peer so the timeout path owns the outcome cleanly.
const hungServer2 = createServer((_req, _res) => {});
const hungPort2 = await listenLoopback(hungServer2);
const hungBaseUrl2 = `http://127.0.0.1:${hungPort2}`;

console.log("\n[case 2] getQaBusState times out against hung peer");
{
  assert("production timeout constant is 10s", () => QA_BUS_STATE_TIMEOUT_MS === 10_000);

  const startedAt = Date.now();
  const outcome = await getQaBusState(hungBaseUrl2, { timeoutMs: 100 }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const elapsedMs = Date.now() - startedAt;

  assert("timed out (not resolved)", () => !outcome.ok);
  if (!outcome.ok) {
    assert(
      "error is a TimeoutError",
      () => outcome.error instanceof Error && outcome.error.name === "TimeoutError",
    );
  }
  assert("resolved in under 2s (not the 10s production floor)", () => elapsedMs < 2_000);
  assert("resolved after the 100ms timeout", () => elapsedMs >= 80);
  console.log(
    "  info: timed_out=%s name=%s elapsed_ms=%d proof_timeout_ms=100 production_timeout_ms=%d",
    !outcome.ok,
    outcome.ok ? "n/a" : outcome.error instanceof Error ? outcome.error.name : typeof outcome.error,
    elapsedMs,
    QA_BUS_STATE_TIMEOUT_MS,
  );
}
await closeServer(hungServer2);

// ---------------------------------------------------------------------------
// [case 3] Valid server still works with the timeout configured
// ---------------------------------------------------------------------------
console.log("\n[case 3] valid response within timeout — resolves normally");
{
  const normalServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        cursor: 1,
        conversations: [],
        threads: [],
        messages: [],
        events: [],
      }),
    );
  });
  const port = await listenLoopback(normalServer);

  const startedAt = Date.now();
  const snapshot = await getQaBusState(`http://127.0.0.1:${port}`, { timeoutMs: 5_000 });
  const elapsedMs = Date.now() - startedAt;

  assert("resolved with expected shape", () => snapshot.cursor === 1);
  assert("resolved quickly (<1s)", () => elapsedMs < 1_000);
  console.log("  info: cursor=%d elapsed_ms=%d", snapshot.cursor, elapsedMs);
  await closeServer(normalServer);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
hungServer.closeAllConnections?.();
await new Promise<void>((resolve, reject) => {
  hungServer.close((err) => (err ? reject(err) : resolve()));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n=== Summary ===");
console.log("production_timeout_ms: %d", QA_BUS_STATE_TIMEOUT_MS);
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) process.exit(1);
