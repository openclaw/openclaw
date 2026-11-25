/** Real cron.list WebSocket previews over isolated synthetic session routes. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { CronDeliveryPreview, CronJob } from "../src/cron/types.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild, type StopChildResult } from "./lib/gateway-bench-child.ts";
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
import { createDeliveryRecoveryFixtures } from "./perf/delivery-recovery-fixture.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    sessions: { type: "string", default: "20" },
    "warm-samples": { type: "string", default: "5" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert.ok(values.out && values.observer, "--out and --observer required");
const sessions = Number(values.sessions);
const warmSamples = Number(values["warm-samples"]);
assert.ok(Number.isSafeInteger(sessions) && sessions > 0 && sessions <= 200);
assert.ok(Number.isSafeInteger(warmSamples) && warmSamples >= 5);
const output = path.resolve(values.out);
// A workload owns its state directory; never adopt an existing Gateway fixture.
mkdirSync(output);
const fixture = path.join(output, "fixture");
const workspace = path.join(fixture, "workspace");
mkdirSync(workspace, { recursive: true });
const routes = createDeliveryRecoveryFixtures(sessions);
const jobs = new Map<string, (typeof routes)[number]>();
const children: Array<{
  child: ChildProcess;
  log: ReturnType<typeof createWriteStream>;
  name: string;
  error?: Error;
  stopping?: Promise<StopChildResult>;
}> = [];
const evidence = {
  ok: false,
  sessions,
  jobsCreated: 0,
  watches: 0,
  sends: 0,
  modelRequests: 0,
  phases: [] as Array<{ phase: string; start: number; end: number }>,
  lists: [] as Array<{ phase: string; previews: boolean; jobs: number; latencyMs: number }>,
};
let phase = "seed";
let phaseStarted = Date.now();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let cleanupPromise: Promise<void> | undefined;
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStarted, end: Date.now() });
  phase = next;
  phaseStarted = Date.now();
  writeFileSync(path.join(output, "phase"), phase);
}
writeFileSync(path.join(output, "phase"), phase);
const bridgeServer = createServer((req, res) => {
  if (req.url === "/watch") {
    evidence.watches++;
  }
  if (req.url === "/sent") {
    evidence.sends++;
  }
  if (req.url?.startsWith("/v1/")) {
    evidence.modelRequests++;
    res.statusCode = 500;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(req.url === "/next" ? "[]" : "{}");
});
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const owned: (typeof children)[number] = { child, log, name };
  child.on("error", (error) => (owned.error = error));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  children.push(owned);
  return owned;
}
function stop(owned: (typeof children)[number]) {
  return (owned.stopping ??= stopChild(owned.child, { teardownGraceMs: 120_000 }).finally(() =>
    owned.log.end(),
  ));
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    client?.close();
    setPhase("shutdown");
    const stopped = await Promise.allSettled(children.map(stop));
    if (bridgeServer.listening) {
      await new Promise<void>((resolve, reject) => {
        bridgeServer.close((error) => (error ? reject(error) : resolve()));
        bridgeServer.closeAllConnections();
      });
    }
    setPhase("done");
    writeFileSync(
      path.join(output, "result.json"),
      `${JSON.stringify({
        ...evidence,
        stopped: stopped.map((result, index) => ({
          name: children[index]!.name,
          ...(result.status === "fulfilled" ? result.value : { failed: true }),
        })),
      })}\n`,
    );
    assert.ok(
      stopped.every((result) => result.status === "fulfilled"),
      "Child cleanup failed",
    );
  })());
}
const onSigint = () => void cleanup().finally(() => process.exit(130));
const onSigterm = () => void cleanup().finally(() => process.exit(143));
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  await new Promise<void>((resolve, reject) => {
    bridgeServer.once("error", reject);
    bridgeServer.listen(0, "127.0.0.1", resolve);
  });
  const address = bridgeServer.address();
  assert.ok(address && typeof address !== "string");
  const token = `synthetic-${randomUUID()}`;
  const bridge = path.join(fixture, "synthetic-imsg");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("scripts/perf/bench-ingress-bridge.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const config: OpenClawConfig = {
    ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token },
      reload: { mode: "off" },
    },
    agents: { defaults: { skipBootstrap: true }, entries: { main: { workspace } } },
    cron: { enabled: true },
    channels: {
      imessage: {
        enabled: true,
        cliPath: bridge,
        dbPath: path.join(fixture, "synthetic-chat.db"),
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
    plugins: {
      ...BASE_GATEWAY_BENCH_CONFIG.plugins,
      entries: {
        ...BASE_GATEWAY_BENCH_CONFIG.plugins.entries,
        imessage: { enabled: true },
        "memory-core": { config: { dreaming: { enabled: false } } },
      },
    },
  };
  // Disabled agentTurn creation still captures a valid configured inference route.
  applyMockOpenAiModelConfig(config, { mockPort: address.port, modelRef: "openai/gpt-4.1" });
  const configPath = writeGatewayBenchConfig(fixture, config, {
    agentList: [{ id: "main", workspace }],
  });
  const env = createGatewayBenchEnv(fixture, configPath, {
    caseEnv: {
      INGRESS_BENCH_URL: `http://127.0.0.1:${address.port}`,
      OPENAI_API_KEY: "synthetic-delivery-fixture",
    },
  });
  const seeded = launch(
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/delivery-recovery-fixture.ts",
      "--sessions",
      String(sessions),
    ],
    env,
    "seed",
  );
  const seededCode = await new Promise<number | null>((resolve, reject) => {
    seeded.child.once("error", reject);
    seeded.child.once("close", resolve);
  });
  assert.equal(seededCode, 0, "Synthetic route seeding failed");
  async function startGateway(name: string) {
    setPhase(`${name}-boot`);
    const previousWatches = evidence.watches;
    const port = await getFreePort();
    const gateway = launch(
      buildGatewayBenchChildArgs(
        path.resolve("dist/entry.js"),
        port,
        name === "measured" && values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : [],
        "token",
      ),
      {
        ...env,
        SQLMEASURE_OUT: output,
        NODE_OPTIONS: `--require=${path.resolve(values.observer!)} --enable-source-maps`,
      },
      name,
    );
    const ready = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: performance.now(),
      deadlineAt: performance.now() + 300_000,
      isDone: () =>
        gateway.error !== undefined ||
        gateway.child.exitCode !== null ||
        gateway.child.signalCode !== null,
    });
    assert.equal(ready.status, 200, "Gateway did not become ready");
    const channelDeadline = Date.now() + 30_000;
    while (evidence.watches === previousWatches && Date.now() < channelDeadline) {
      await delay(25);
    }
    assert.ok(evidence.watches > previousWatches, "Synthetic channel did not become ready");
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    const connected = await client.request(
      "connect",
      {
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
      },
      120_000,
    );
    assert.ok(connected.ok, "Synthetic client admission failed");
    return gateway;
  }
  const setup = await startGateway("setup");
  setPhase("create-jobs");
  for (const route of routes) {
    const added = await client!.request(
      "cron.add",
      {
        name: route.sessionId,
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        sessionKey: route.sessionKey,
        agentId: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Synthetic fixture" },
        delivery: { mode: "announce", channel: "last" },
      },
      120_000,
    );
    assert.ok(added.ok, "Disabled synthetic job creation failed");
    const job = added.payload as CronJob;
    assert.equal(job.enabled, false);
    assert.equal(job.sessionKey, route.sessionKey);
    jobs.set(job.id, route);
    evidence.jobsCreated++;
  }
  client!.close();
  client = undefined;
  setPhase("setup-shutdown");
  const setupStopped = await stop(setup);
  assert.notEqual(setupStopped.signal, "SIGKILL", "Setup required forced cleanup");
  // cron.add prepares previews. A new process makes the first measured list cold.
  await startGateway("measured");
  async function list(name: string, previews: boolean) {
    setPhase(name);
    const started = performance.now();
    const response = await client!.request(
      "cron.list",
      { includeDisabled: true, limit: 200, includeDeliveryPreviews: previews },
      120_000,
    );
    const latencyMs = performance.now() - started;
    assert.ok(response.ok, "Synthetic cron list failed");
    const payload = response.payload as {
      jobs: CronJob[];
      total: number;
      deliveryPreviews?: Record<string, CronDeliveryPreview>;
    };
    assert.equal(payload.total, sessions);
    assert.equal(payload.jobs.length, sessions);
    assert.deepEqual(payload.jobs.map((job) => job.id).toSorted(), [...jobs.keys()].toSorted());
    if (previews) {
      assert.equal(Object.keys(payload.deliveryPreviews ?? {}).length, sessions);
      for (const job of payload.jobs) {
        assert.equal(
          payload.deliveryPreviews?.[job.id]?.label,
          `announce -> imessage:auto:${jobs.get(job.id)!.to}`,
          "Delivery preview did not resolve its own route",
        );
      }
    } else {
      assert.equal(payload.deliveryPreviews, undefined);
    }
    evidence.lists.push({ phase: name, previews, jobs: payload.jobs.length, latencyMs });
  }
  await list("cold-preview", true);
  await list("post-cold-control", false);
  for (let index = 1; index <= warmSamples; index++) {
    await list(`warm-preview-${index}`, true);
    await list(`warm-control-${index}`, false);
  }
  assert.equal(evidence.sends, 0, "Dry-run previews sent an external notification");
  assert.equal(evidence.modelRequests, 0, "Disabled jobs invoked a model");
  assert.ok(evidence.watches >= 2, "Synthetic channel did not start in both Gateway processes");
  evidence.ok = true;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
