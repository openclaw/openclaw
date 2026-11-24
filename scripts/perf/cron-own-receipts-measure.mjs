/**
 * Real cron.runs handler + SQLite history owner, without a Gateway transport or model.
 * Seed once, then run serial baseline/candidate arms against the same synthetic state:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-own-receipts-measure.mjs \
 *     --state-dir .local/cron-receipts/fixture --seed
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-own-receipts-measure.mjs \
 *     --state-dir .local/cron-receipts/fixture --output .local/cron-receipts/head.json
 * --owner-dir overlays only cron-caller-scope.ts and cron-runs.ts at canonical URLs.
 * Each scenario warms independently for the requested iteration count before timing.
 * Use five alternating A/B pairs and two A/A pairs. Baseline cross-account refusal
 * and candidate's useful history read do different work; report that cost, not a speedup.
 * Same-account history is the behavior-preserving control. The fixture contains
 * 1,000 jobs and 20,000 run sessions/receipts. No agent DB or workspace files are
 * needed by this owner; this does not claim 35 GiB/btrfs/whole-Gateway parity.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "200" },
  },
});
assert(values["state-dir"] && global.gc, "--state-dir and --expose-gc required");
const root = path.resolve(values["state-dir"]);
const configPath = path.join(root, "openclaw.json");
const marker = path.join(root, "cron-own-receipts-fixture.json");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
if (values.seed) {
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root, { recursive: false });
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { enabled: false }, agents: { entries: { main: {} } } }),
  );
} else {
  assert(values.output && existsSync(marker), "--output and a seeded synthetic fixture required");
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CRON: "1",
});
const sources = [
  "src/gateway/server-methods/cron-caller-scope.ts",
  "src/gateway/server-methods/cron-runs.ts",
];
const repository = fileURLToPath(new URL("../../", import.meta.url));
const frozen = new Map(
  sources.map((relative) => {
    const overlay = values["owner-dir"] && path.join(path.resolve(values["owner-dir"]), relative);
    const source = readFileSync(
      overlay && existsSync(overlay) ? overlay : path.join(repository, relative),
      "utf8",
    );
    return [new URL(`../../${relative}`, import.meta.url).href, source];
  }),
);
registerHooks({
  load(url, context, nextLoad) {
    const source = frozen.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const cfg = JSON.parse(await readFile(configPath, "utf8"));
setRuntimeConfigSnapshot(cfg);
const { saveCronStore } = await import("../../src/cron/store.js");
const { runOpenClawStateWriteTransaction, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { recordCronRunInDatabase } = await import("../../src/cron/store/run-history.kernel.js");
const { cronRunLogEntryToDetail } = await import("../../src/cron/run-history-detail.js");
const { cronStoreKey } = await import("../../src/cron/store/key.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const storePath = path.join(root, "cron", "jobs.json");
const storeKey = cronStoreKey(storePath);
const jobs = 1000,
  runsPerJob = 20;
const now = 1_800_000_000_000;
try {
  if (values.seed) {
    const started = performance.now();
    await saveCronStore(storePath, {
      version: 1,
      jobs: Array.from({ length: jobs }, (_, index) => ({
        id: `synthetic-${index}`,
        name: `Synthetic receipt job ${index}`,
        agentId: "main",
        owner: { agentId: "main", sessionKey: `agent:main:owner-${index}`, accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: `agent:main:owner-${index}`,
          ownerAccountId: "default",
        },
        enabled: false,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Read this job's delivery receipts" },
        delivery: {
          mode: "announce",
          channel: "discord",
          accountId: "delivery-account",
          to: "channel:synthetic",
        },
        state: {},
      })),
    });
    runOpenClawStateWriteTransaction(({ db }) => {
      for (let job = 0; job < jobs; job++) {
        for (let run = 0; run < runsPerJob; run++) {
          const jobId = `synthetic-${job}`,
            runId = `receipt-${job}-${run}`;
          const entry = {
            action: "finished",
            jobId,
            runId,
            ts: now + run,
            status: "ok",
            summary: "Synthetic successful delivery",
            sessionKey: `agent:main:run-${job}-${run}`,
            delivered: true,
            deliveryStatus: "delivered",
            delivery: {
              resolved: {
                channel: "discord",
                accountId: "delivery-account",
                to: "channel:synthetic",
              },
              delivered: true,
              receipts: [
                {
                  channel: "discord",
                  accountId: "delivery-account",
                  to: "channel:synthetic",
                  messageId: `synthetic-message-${job}-${run}`,
                },
              ],
            },
          };
          recordCronRunInDatabase(db, {
            storeKey,
            jobId,
            runId,
            agentId: "main",
            sessionKey: entry.sessionKey,
            startedAt: entry.ts,
            endedAt: entry.ts,
            status: "succeeded",
            summary: entry.summary,
            detail: cronRunLogEntryToDetail(entry, { storeKey }),
          });
        }
      }
    });
    await writeFile(
      marker,
      JSON.stringify({
        jobs,
        runs: jobs * runsPerJob,
        runSessions: jobs * runsPerJob,
        fixtureMs: performance.now() - started,
      }),
    );
    console.log(await readFile(marker, "utf8"));
  } else {
    const { CronService } = await import("../../src/cron/service.js");
    const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
    const { cronRunsHandler } = await import("../../src/gateway/server-methods/cron-runs.js");
    const { createOperationalRunInstanceRef } =
      await import("../../src/agents/operational-run-instance.js");
    const { claimAgentRunDelegatedAuthority, releaseAgentRunDelegatedAuthority } =
      await import("../../src/infra/agent-run-registry.js");
    const { createAgentRuntimeApprovalAuthorityValidator } =
      await import("../../src/gateway/agent-runtime-approval-authority.js");
    const { onWorkerRequestMetrics } =
      await import("../../src/infra/worker-request-diagnostics.js");
    const scheduler = new GatewayScheduler();
    const cron = new CronService({
      scheduler,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      nowMs: () => now,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      enqueueSystemEvent() {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const operationalRunInstance = createOperationalRunInstanceRef("synthetic-reader");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const client = {
      connect: {},
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:scheduled-reader",
          operationalRunInstance,
          delegatedAuthority: { kind: "local", ...authority },
          turnSourceAccountId: "default",
          cronSelfManagementContext: { jobId: "synthetic-0", expiresAtMs: Date.now() + 3600_000 },
        },
      },
    };
    const context = {
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    };
    const query = async (job, account, sibling = false) => {
      const identity = client.internal.agentRuntimeIdentity;
      identity.turnSourceAccountId = account;
      identity.cronSelfManagementContext.jobId = `synthetic-${job}`;
      const params = { id: `synthetic-${sibling ? (job + 1) % jobs : job}`, limit: 5 };
      let response;
      await cronRunsHandler({
        params,
        context,
        client,
        req: { type: "req", id: "measure", method: "cron.runs", params },
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      assert(response);
      if (response.ok) {
        assert.equal(response.payload.total, runsPerJob);
        assert.equal(response.payload.entries.length, 5);
        assert(
          response.payload.entries.every(
            (entry) => entry.jobId === params.id && entry.deliveryStatus === "delivered",
          ),
        );
      } else {
        assert.equal(response.error.details.code, "CRON_JOB_NOT_FOUND");
      }
      return response.ok;
    };
    try {
      await cron.start();
      await cron.readJob("synthetic-0");
      const rows = [];
      for (const [scenario, account, sibling] of [
        ["same-account", "default", false],
        ["delivery-account", "delivery-account", false],
        ["other-job", "delivery-account", true],
      ]) {
        // Refusal paths must be equally warm: the baseline's preceding cross-account
        // case refuses while the repaired owner's same request succeeds.
        for (let i = 0; i < iterations; i++) {
          await query(i % jobs, account, sibling);
        }
        global.gc();
        const latency = new Float64Array(iterations);
        const allocatedBefore = getHeapStatistics().total_allocated_bytes;
        assert(Number.isFinite(allocatedBefore), "Node must expose total_allocated_bytes");
        const cpu = process.cpuUsage(),
          mainCpu = process.threadCpuUsage(),
          hostLoad = loadavg();
        let accepted = 0;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) {
          const begin = performance.now();
          accepted += Number(await query(i % jobs, account, sibling));
          latency[i] = performance.now() - begin;
        }
        const elapsedMs = performance.now() - start;
        const usedCpu = process.cpuUsage(cpu),
          usedMain = process.threadCpuUsage(mainCpu);
        const allocated = getHeapStatistics().total_allocated_bytes - allocatedBefore;
        latency.sort();
        rows.push({
          scenario,
          iterations,
          accepted,
          denied: iterations - accepted,
          elapsedMs,
          p50Ms: latency[Math.ceil(iterations * 0.5) - 1],
          p95Ms: latency[Math.ceil(iterations * 0.95) - 1],
          maxMs: latency.at(-1),
          cpuMsPerCall: (usedCpu.user + usedCpu.system) / 1000 / iterations,
          mainCpuMsPerCall: (usedMain.user + usedMain.system) / 1000 / iterations,
          allocatedMainBytesPerCall: allocated / iterations,
          hostLoad,
        });
        const counts = new Map();
        const unsubscribe = onWorkerRequestMetrics((kind, requestClass, phase) => {
          if (phase === "completed") {
            const key = `${kind}:${requestClass}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        });
        try {
          await query(0, account, sibling);
        } finally {
          unsubscribe();
        }
        rows.at(-1).workerRequestsPerCall = Object.fromEntries(counts);
      }
      const report = {
        scope:
          "cron.runs handler + real SQLite history; no transport/model or agent-database/workspace access",
        node: process.version,
        warmupPerScenario: iterations,
        fixture: JSON.parse(await readFile(marker, "utf8")),
        owners: [...frozen].map(([url, source]) => ({
          url,
          sha256: createHash("sha256").update(source).digest("hex"),
        })),
        rows,
      };
      await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report));
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      cron.stop();
      await scheduler.stop();
    }
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
