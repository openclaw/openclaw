// Synthetic category registration through the real Gateway WebSocket transport.
// Built-CLI mutation proof (fresh state per baseline/candidate run):
// node --import ./scripts/tsx.mjs scripts/perf/session-group-registration-measure.ts \
//   --mutations --entry dist/entry.js --state-dir .local/group-run --registrations 20
// Alternate baseline/candidate builds for >=5 pairs; first-use and warm timings
// stay separate. Add --cpu-profile only for a separate diagnostic run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    registrations: { type: "string", default: "20" },
    entry: { type: "string" },
    mutations: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
const registrations = Number(values.registrations);
assert(Number.isSafeInteger(registrations) && registrations > 0);
const entry = values.entry ? path.resolve(values.entry) : undefined;
assert(!values.mutations || entry, "--mutations requires a built --entry dist/entry.js");
assert(!entry || entry.endsWith(`${path.sep}dist${path.sep}entry.js`));
assert(!values["cpu-profile"] || entry, "--cpu-profile requires --entry");
const directory = path.resolve(values["state-dir"]);
mkdirSync(directory);
for (const name of ["home", "workspace", "tmp"]) {
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
      ownership: "explicit",
      defaults: { model: { primary: "synthetic/model" }, systemAgent: { agentId: "main" } },
      entries: Object.fromEntries(
        (values.mutations ? ["main", "other", "third"] : ["main"]).map((id) => [
          id,
          { workspace: path.join(directory, "workspace", id) },
        ]),
      ),
    },
    cron: { enabled: false },
    logging: { file: path.join(directory, "gateway-file.log") },
  }),
);
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_PROFILE: `group-measure-${port}`,
    TMPDIR: path.join(directory, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    ...Object.fromEntries(
      [
        "SQLMEASURE_OUT",
        "NODE_OPTIONS",
        "NODE_DISABLE_COMPILE_CACHE",
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
const { GatewayClient } = await import("../../src/gateway/client.js");
// Keep the original in-process registration probe, but require the shipped CLI
// boundary for mutation latency so source-loader startup is not measured.
const child = entry
  ? spawn(
      process.execPath,
      buildGatewayBenchChildArgs(
        entry,
        port,
        gatewayBenchCpuProfileArgs(
          values["cpu-profile"] ? path.join(directory, "profiles") : undefined,
        ),
        "token",
      ),
      {
        cwd: path.dirname(path.dirname(entry)),
        env: process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
  : undefined;
const server = child
  ? undefined
  : await (
      await import("../../src/gateway/server.js")
    ).startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
    });
if (child) {
  const log = createWriteStream(path.join(directory, "gateway.log"));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once("close", () => log.end());
}
const ready = Promise.withResolvers<void>();
const peer = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  clientBuildId: entry
    ? (readBuildIdFromBuildInfoForModuleUrl(pathToFileURL(entry).href) ?? undefined)
    : undefined,
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
const hostLoad = { before: loadavg(), after: [] as number[] };
async function mutationProbe() {
  for (const agentId of ["main", "other", "third"]) {
    await peer.request("sessions.create", {
      agentId,
      key: agentId === "main" ? key : `agent:${agentId}:dashboard:bystander`,
      category: agentId === "main" ? "Old" : "Unrelated",
    });
  }
  const describe = async (sessionKey: string) =>
    (
      await peer.request<{ session: { category?: string; updatedAt: number } }>(
        "sessions.describe",
        { key: sessionKey },
      )
    ).session;
  const timed = async (label: string, method: string, params: object) => {
    const before = await describe(key);
    const started = performance.now();
    const result = await peer.request<{ updatedSessions: number }>(method, params);
    timings.push({ phase: label, ms: performance.now() - started });
    assert.equal((await describe(key)).updatedAt, before.updatedAt);
    return result;
  };
  let name = "Old";
  for (let i = 0; i <= registrations; i++) {
    const label = i === 0 ? "first" : "warm";
    const to = name === "Old" ? "New" : "Old";
    assert.equal(
      (await timed(`${label}-rename`, "sessions.groups.rename", { name, to })).updatedSessions,
      1,
    );
    name = to;
    assert.equal((await describe(key)).category, name);
    assert.equal(
      (await timed(`${label}-delete`, "sessions.groups.delete", { name })).updatedSessions,
      1,
    );
    assert.equal((await describe(key)).category, undefined);
    await peer.request("sessions.patch", { key, category: name });
    await peer.request("sessions.groups.put", { names: [name, "Unrelated", "Empty"] });
    assert.equal(
      (await timed(`${label}-empty-delete`, "sessions.groups.delete", { name: "Empty" }))
        .updatedSessions,
      0,
    );
    const catalog = await peer.request<{ groups: Array<{ name: string }> }>(
      "sessions.groups.list",
      {},
    );
    assert.deepEqual(
      catalog.groups.map((group) => group.name).toSorted(),
      [name, "Unrelated"].toSorted(),
    );
    for (const agentId of ["other", "third"]) {
      assert.equal((await describe(`agent:${agentId}:dashboard:bystander`)).category, "Unrelated");
    }
  }
}
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
let completed = false;
try {
  if (child) {
    const probe = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: performance.now(),
      deadlineAt: performance.now() + 180_000,
      isDone: () => child.exitCode !== null || child.signalCode !== null,
    });
    assert.equal(probe.status, 200, `Gateway failed readiness; inspect ${directory}/gateway.log`);
  }
  peer.start();
  await ready.promise;
  if (values.mutations) {
    await mutationProbe();
  } else {
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
  }
  hostLoad.after = loadavg();
  const result = {
    ok: true,
    registrations,
    timings,
    hostLoad,
    node: process.version,
    entry,
    mode: values["cpu-profile"] ? "cpu-diagnostic" : "timing",
    buildInfo: entry
      ? JSON.parse(readFileSync(path.join(path.dirname(entry), "build-info.json"), "utf8"))
      : undefined,
    entrySha256: entry ? createHash("sha256").update(readFileSync(entry)).digest("hex") : undefined,
    summary: Object.fromEntries(
      [...new Set(timings.map((row) => row.phase))].map((label) => [
        label,
        summarizeNumbers(timings.filter((row) => row.phase === label).map((row) => row.ms)),
      ]),
    ),
  };
  writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  completed = true;
} finally {
  phase("shutdown");
  peer.stop();
  if (child) {
    const shutdown = await stopChild(child, { teardownGraceMs: 30_000 });
    writeFileSync(path.join(directory, "shutdown.json"), JSON.stringify(shutdown));
    if (completed) {
      assert.equal(shutdown.exitCode, 0);
    }
  }
  await server?.close({ reason: "synthetic category registration completed" });
}
