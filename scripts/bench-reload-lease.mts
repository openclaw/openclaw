/** Synthetic config.set reloads and plugin activation over an isolated Gateway WebSocket. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    samples: { type: "string", default: "5" },
    "settle-seconds": { type: "string", default: "5" },
    "idle-seconds": { type: "string", default: "60" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert.ok(values.out && values.observer, "--out and --observer required");
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const output = path.resolve(values.out);
const fixture = path.join(output, "fixture");
mkdirSync(fixture, { recursive: true });
assert.ok(!readFileIfPresent(path.join(output, "result.json")), "Use a fresh output directory");
function readFileIfPresent(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}
function setPhase(phase: string) {
  writeFileSync(path.join(output, "phase"), phase);
}
const token = `synthetic-${randomUUID()}`;
const config: OpenClawConfig = {
  ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    auth: { mode: "token", token },
    reload: { mode: "hot", debounceMs: 10 },
  },
  agents: {
    defaults: { skipBootstrap: true },
    entries: { main: { workspace: path.join(fixture, "workspace") } },
  },
};
const configPath = writeGatewayBenchConfig(fixture, config, {
  agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }],
});
const port = await getFreePort();
setPhase("boot");
const log = createWriteStream(path.join(output, "gateway.log"));
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(
    path.resolve("dist/entry.js"),
    port,
    values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : [],
    "token",
  ),
  {
    env: {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
gateway.stdout.pipe(log);
gateway.stderr.pipe(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const result = { ok: false, writes: 0, observations: 0, samples, applied: 0 };
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    client?.close();
    setPhase("shutdown");
    const stopped = await stopChild(gateway, { teardownGraceMs: 120_000 });
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify({ ...result, stopped })}\n`);
    log.end();
  })());
}
const onSigint = () => void cleanup().finally(() => process.exit(130));
const onSigterm = () => void cleanup().finally(() => process.exit(143));
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway did not become ready");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  assert.equal(
    (
      await client.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        auth: { token },
        caps: [],
      })
    ).ok,
    true,
    "Synthetic client admission failed",
  );
  setPhase("settle");
  await delay(Number(values["settle-seconds"]) * 1_000);
  for (let sample = 0; sample < samples + 2; sample++) {
    setPhase(
      sample < samples
        ? sample === 0
          ? "first-reload"
          : `warm-reload-${sample}`
        : sample === samples
          ? "plugin-enable"
          : "plugin-disable",
    );
    const observed = await client.request("config.get", {}, 120_000);
    assert.ok(observed.ok, "Config observation failed");
    result.observations++;
    const payload = observed.payload as { hash: string };
    const next = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
    if (sample < samples) {
      next.messages = { ...next.messages, ackReaction: sample % 2 ? "" : "🧪" };
    } else {
      next.plugins = {
        ...next.plugins,
        entries: { ...next.plugins?.entries, diffs: { enabled: sample === samples } },
      };
    }
    const written = await client.request(
      "config.set",
      { raw: JSON.stringify(next), baseHash: payload.hash },
      120_000,
    );
    assert.ok(written.ok, "Config write failed");
    const writtenHash = (written.payload as { hash: string }).hash;
    assert.equal(typeof writtenHash, "string", "Config write omitted its revision");
    result.writes++;
    // config.set acknowledges persistence; the applied revision proves the reload completed.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const current = await client.request("config.get", {}, 120_000);
      assert.ok(current.ok, "Reload observation failed");
      result.observations++;
      const snapshot = current.payload as {
        hash?: string;
        configRevisionHash?: string;
        appliedConfigHash?: string;
      };
      if (
        snapshot.hash === writtenHash &&
        typeof snapshot.configRevisionHash === "string" &&
        snapshot.appliedConfigHash === snapshot.configRevisionHash
      ) {
        result.applied++;
        break;
      }
      assert.ok(Date.now() < deadline, "Reload did not publish its applied revision");
      await delay(100);
    }
    setPhase(`reload-settle-${sample}`);
    await delay(1_000);
  }
  setPhase("idle");
  await delay(Number(values["idle-seconds"]) * 1_000);
  result.ok = true;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
