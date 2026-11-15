/** Real Gateway RPC + Team Reports workers; synthetic one-commit HTTP fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { describePeriod } from "../extensions/team-reports/src/periods.js";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.js";
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
    "settle-ms": { type: "string", default: "2000" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.out && values.observer, "--out and --observer are required");
const samples = Number(values.samples);
const settleMs = Number(values["settle-ms"]);
assert(Number.isSafeInteger(samples) && samples >= 5, "--samples must be at least 5");
assert(Number.isSafeInteger(settleMs) && settleMs >= 1, "--settle-ms must be positive");
const repo = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(values.out);
const fixture = path.join(output, "fixture");
mkdirSync(output, { recursive: true });
mkdirSync(fixture);
mkdirSync(path.join(fixture, "workspace"));
const phases: { phase: string; startedAt: number; finishedAt?: number }[] = [];
function setPhase(phase: string) {
  const now = Date.now();
  if (phases.length) {
    phases[phases.length - 1]!.finishedAt = now;
  }
  phases.push({ phase, startedAt: now });
  writeFileSync(path.join(output, "phase"), phase);
}
setPhase("boot");
const configPath = writeGatewayBenchConfig(
  fixture,
  {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { defaults: { skipBootstrap: true } },
    plugins: {
      enabled: true,
      allow: ["team-reports"],
      entries: {
        "team-reports": {
          enabled: true,
          config: {
            github: { token: "synthetic-fixture", orgs: ["sample"] },
            people: [{ github: ["alex"] }],
            summaries: { enabled: false },
            schedule: { enabled: false, weekly: true, monthly: true },
          },
        },
      },
    },
  },
  { agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }] },
);
const port = await getFreePort();
const preload = fileURLToPath(
  new URL("./perf/team-reports-snapshots-preload.mjs", import.meta.url),
);
const log = createWriteStream(path.join(output, "gateway.log"));
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs("src/entry.ts", port, [
    "--import",
    "./scripts/tsx.mjs",
    "--import",
    preload,
    ...(values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : []),
  ]),
  {
    cwd: repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: createGatewayBenchEnv(fixture, configPath, {
      caseEnv: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repo, "extensions"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        SQLMEASURE_OUT: output,
        NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))} --enable-source-maps`,
      },
    }),
  },
);
gateway.stdout?.pipe(log);
gateway.stderr?.pipe(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    client?.close();
    await stopChild(gateway, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
  })());
const interrupt = () => void stop().finally(() => process.exit(130));
const terminate = () => void stop().finally(() => process.exit(143));
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
const statusSchema = z.object({
  running: z.boolean(),
  activeRunId: z.string().optional(),
  runs: z.array(z.object({ id: z.string(), status: z.enum(["running", "ok", "error"]) })),
});
const reportSchema = z.object({
  report: z.object({
    totals: z.object({ github: z.object({ commits: z.number() }) }),
  }),
});
const date = "2026-08-19";
const periods = ["day", "week", "month"] as const;
const results: { phase: string; reports: number }[] = [];
let ok = false;
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway did not become ready; inspect gateway.log");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await client!.request(method, params);
    assert(response.ok, `${method} failed: ${JSON.stringify(response.error)}`);
    return response.payload;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  const status = () => rpc("team-reports.status").then((value) => statusSchema.parse(value));
  assert((await status()).running, "Team Reports did not start");
  const generate = async () =>
    z
      .object({ runId: z.string() })
      .parse(await rpc("team-reports.generate", { period: "day", date })).runId;
  const assertComplete = (value: z.infer<typeof statusSchema>, runId: string) => {
    assert.equal(
      value.activeRunId,
      undefined,
      "Run not settled; increase --settle-ms for both heads",
    );
    assert.equal(
      value.runs.find((run) => run.id === runId)?.status,
      "ok",
      "Report generation failed",
    );
  };
  setPhase("warmup");
  const warmupId = await generate();
  let warmup = await status();
  const deadline = Date.now() + 120_000;
  while (warmup.activeRunId && Date.now() < deadline) {
    await delay(100);
    warmup = await status();
  }
  assertComplete(warmup, warmupId);
  for (let index = 0; index < samples; index++) {
    const phase = `warm-${index + 1}`;
    setPhase(phase);
    const runId = await generate();
    // Fixed one status read per action: faster completion must not change SQL counts.
    await delay(settleMs);
    assertComplete(await status(), runId);
    for (const period of periods) {
      const descriptor = describePeriod(period, date);
      const report = reportSchema.parse(
        await rpc("team-reports.get", {
          period,
          key: descriptor.key,
          format: "json",
        }),
      );
      assert.equal(
        report.report.totals.github.commits,
        1,
        `${period} rollup lost the fixture commit`,
      );
    }
    results.push({ phase, reports: periods.length });
  }
  ok = true;
} finally {
  setPhase("shutdown");
  await stop();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  setPhase("done");
  writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify(
      {
        ok,
        fixture: "one synthetic commit",
        samples,
        settleMs,
        phases,
        results,
        expectedAggregatePeriodCalls: samples * 2,
        expectedCandidateSqlDelta: -samples * 4,
        expectedRequestDelta: 0,
        measuredTiming: false,
        cpuProfile: values["cpu-profile"],
      },
      null,
      2,
    ),
  );
}
assert(ok);
console.log(JSON.stringify({ output, ok, samples, expectedCandidateSqlDelta: -samples * 4 }));
