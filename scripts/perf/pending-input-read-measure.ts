// Synthetic retained-input reads through the real Gateway WebSocket transport.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    reads: { type: "string", default: "10" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
const reads = Number(values.reads);
assert(Number.isSafeInteger(reads) && reads > 0);
const directory = path.resolve(values["state-dir"]);
mkdirSync(directory);
for (const name of ["home", "workspace"]) {
  mkdirSync(path.join(directory, name));
}
const configPath = path.join(directory, "openclaw.json");
const port = await getFreePort();
const config = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    defaults: { model: { primary: "synthetic/model" } },
    entries: { main: { workspace: path.join(directory, "workspace") } },
  },
  cron: { enabled: false },
};
writeFileSync(configPath, JSON.stringify(config));
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_SKIP_CHANNELS: "1",
    ...(process.env.SQLMEASURE_OUT ? { SQLMEASURE_OUT: process.env.SQLMEASURE_OUT } : {}),
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  },
});
const phase = (name: string) => {
  if (process.env.SQLMEASURE_OUT) {
    writeFileSync(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
};
phase("seed");
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { stageSessionPendingInput } =
  await import("../../src/config/sessions/session-accessor.pending-inputs.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const scope = {
  agentId: "main",
  sessionKey: "agent:main:pending-read-bench",
  sessionId: "pending-read-bench",
};
setRuntimeConfigSnapshot(config);
await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
const receipt = await stageSessionPendingInput(scope, {
  runId: "synthetic-retained-input",
  message: {
    role: "user",
    content: "Synthetic retained input",
    timestamp: 1,
    idempotencyKey: "synthetic-retained-input:user",
  },
  assertCurrent() {},
});
assert(receipt);
receipt.finish("interrupted");
await receipt.settled?.();
await closeOpenClawAgentDatabasesAsync();
clearRuntimeConfigSnapshot();
phase("boot");
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const ready = Promise.withResolvers<void>();
const peer = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  mode: "webchat",
  platform: "web",
  instanceId: "synthetic-pending-read",
  scopes: ["operator.admin"],
  requestTimeoutMs: 60_000,
  onHelloOk: () => ready.resolve(),
  onConnectError: (error) => ready.reject(error),
});
try {
  peer.start();
  await ready.promise;
  for (let index = 0; index <= reads; index++) {
    phase(index === 0 ? "cold-read" : `warm-read-${index}`);
    const result: {
      ok: boolean;
      message?: { role: string; content: unknown };
    } = await peer.request("chat.message.get", {
      sessionKey: scope.sessionKey,
      messageId: `pending:${receipt.inputId}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.message?.role, "user");
    assert(JSON.stringify(result.message?.content).includes("Synthetic retained input"));
  }
  phase("missing-read");
  const missing = await peer.request<{ ok: boolean; unavailableReason: string }>(
    "chat.message.get",
    { sessionKey: scope.sessionKey, messageId: "pending:synthetic-missing" },
  );
  assert.deepEqual(missing, { ok: false, unavailableReason: "not_found" });
  writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ok: true, reads, port }));
  console.log(JSON.stringify({ ok: true, reads }));
} finally {
  phase("shutdown");
  peer.stop();
  await server.close({ reason: "synthetic pending read completed" });
}
