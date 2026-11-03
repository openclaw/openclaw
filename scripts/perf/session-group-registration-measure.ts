// Synthetic category registration through the real Gateway WebSocket transport.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    registrations: { type: "string", default: "20" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
const registrations = Number(values.registrations);
assert(Number.isSafeInteger(registrations) && registrations > 0);
const directory = path.resolve(values["state-dir"]);
mkdirSync(directory);
for (const name of ["home", "workspace"]) {
  mkdirSync(path.join(directory, name));
}
const configPath = path.join(directory, "openclaw.json");
const port = await getFreePort();
const token = "synthetic-category-registration-token";
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token },
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { main: { workspace: path.join(directory, "workspace") } },
    },
    cron: { enabled: false },
  }),
);
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_SKIP_CHANNELS: "1",
    ...Object.fromEntries(
      [
        "SQLMEASURE_OUT",
        "NODE_OPTIONS",
        "NODE_DISABLE_COMPILE_CACHE",
        "TMPDIR",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
        "OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT",
      ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
  },
});
const phase = (name: string) => {
  if (process.env.SQLMEASURE_OUT) {
    writeFileSync(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
};
phase("boot");
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const ready = Promise.withResolvers<void>();
const peer = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  mode: "webchat",
  platform: "web",
  instanceId: "synthetic-category-registration",
  scopes: ["operator.admin"],
  requestTimeoutMs: 60_000,
  onHelloOk: () => ready.resolve(),
  onConnectError: (error) => ready.reject(error),
});
const key = "agent:main:dashboard:category-registration";
const expected: Array<{ name: string; position: number }> = [];
const timings: Array<{ phase: string; ms: number }> = [];
async function assign(category: string, cold = false) {
  const label = cold ? "cold-new" : `warm-new-${expected.length}`;
  phase(label);
  const started = performance.now();
  const result = await peer.request<{ entry: { category: string } }>(
    cold ? "sessions.create" : "sessions.patch",
    {
      ...(cold ? { agentId: "main" } : {}),
      key,
      category,
    },
  );
  timings.push({ phase: label, ms: performance.now() - started });
  assert.equal(result.entry.category, category);
  expected.push({ name: category, position: expected.length });
  phase("readback");
  const listed = await peer.request<{ groups: Array<{ name: string; position: number }> }>(
    "sessions.groups.list",
    {},
  );
  assert.deepEqual(listed.groups, expected);
}
try {
  peer.start();
  await ready.promise;
  await assign("Cold", true);
  for (let index = 0; index < registrations; index++) {
    await assign(`Warm ${index}`);
  }
  for (let index = 0; index < registrations; index++) {
    const label = `warm-existing-${index}`;
    phase(label);
    const started = performance.now();
    const result = await peer.request<{ entry: { category: string } }>("sessions.patch", {
      key,
      category: "Cold",
    });
    timings.push({ phase: label, ms: performance.now() - started });
    assert.equal(result.entry.category, "Cold");
  }
  phase("readback");
  const listed = await peer.request<{ groups: Array<{ name: string; position: number }> }>(
    "sessions.groups.list",
    {},
  );
  assert.deepEqual(listed.groups, expected);
  const result = { ok: true, registrations, timings };
  writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  phase("shutdown");
  peer.stop();
  await server.close({ reason: "synthetic category registration completed" });
}
