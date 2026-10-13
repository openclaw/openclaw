// Run manually on a Testbox: node --expose-gc --import ./scripts/tsx.mjs extensions/team-reports/src/report-run.benchmark.test-support.ts [--worker]
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { parseTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import {
  createReportRunFixtureFetch,
  fixtureChannels,
  fixtureDay,
  fixturePeople,
} from "./report-run.benchmark-fixtures.test-support.js";
import { TeamReportsRunner } from "./run-worker.js";
import {
  createReportSources,
  generateReportPeriods,
  type ResolvedTeamReportsConfig,
} from "./run.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore } from "./store.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "team-reports-benchmark-"));
const store = await createTeamReportsStore({
  stateDir: directory,
  workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
});
const config = parseTeamReportsConfig({
  github: { token: "synthetic-fixture", orgs: ["fixture"] },
  discord: { token: "synthetic-fixture", guildId: "1000", channels: fixtureChannels },
  people: fixturePeople,
  summaries: { enabled: false },
});
const resolved: ResolvedTeamReportsConfig = {
  github: { ...config.github, token: "synthetic-fixture", ignoreCommentPatterns: [] },
  discord: {
    ...config.discord!,
    token: "synthetic-fixture",
    apiBaseUrl: "https://discord.com/api/v10",
  },
  people: fixturePeople,
};
const periods = [describePeriod("day", fixtureDay), describePeriod("month", fixtureDay)];
const workerMode = process.argv.includes("--worker");
let runner: TeamReportsRunner | undefined;
globalThis.gc?.();
const initialHeap = process.memoryUsage().heapUsed;
let peakHeap = initialHeap;
let maxSyncCallbackMs = 0;
let callbackCount = 0;
const starts: number[] = [];
const sampleHeap = () => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
};
const hook = createHook({
  before() {
    starts.push(performance.now());
  },
  after() {
    const start = starts.pop();
    if (start !== undefined) {
      maxSyncCallbackMs = Math.max(maxSyncCallbackMs, performance.now() - start);
    }
    if (++callbackCount % 128 === 0) {
      sampleHeap();
    }
  },
});
const monitoring = new AbortController();
let maxMainThreadTurnMs = 0;
const heartbeat = async () => {
  let previous = performance.now();
  while (!monitoring.signal.aborted) {
    await nextTurn();
    const now = performance.now();
    maxMainThreadTurnMs = Math.max(maxMainThreadTurnMs, now - previous);
    previous = now;
    sampleHeap();
  }
};
const logger = { info: sampleHeap, warn: sampleHeap, error: sampleHeap };
const start = performance.now();
hook.enable();
const heartbeatDone = heartbeat();
try {
  runner = workerMode
    ? new TeamReportsRunner(
        new URL("./report-run.benchmark-worker.test-support.ts", import.meta.url),
      )
    : undefined;
  const generate = runner ? runner.run.bind(runner) : generateReportPeriods;
  const statuses = await generate({
    config,
    resolved,
    store,
    periods,
    sources: (runtime) => createReportSources(runtime, true),
    llm: {
      complete: async () => {
        throw new Error("Benchmark must not invoke a model");
      },
    },
    runtime: {
      logger,
      fetchImpl: createReportRunFixtureFetch(),
      signal: new AbortController().signal,
    },
    onRoster: () => {},
  });
  sampleHeap();
  const durationMs = performance.now() - start;
  monitoring.abort();
  await heartbeatDone;
  hook.disable();
  assert.ok(
    Object.values(statuses).every((source) => source.ok),
    JSON.stringify(statuses),
  );
  const reports = [];
  for (const period of periods) {
    const document = await store.getPeriod(period.period, period.key);
    assert.ok(document);
    assert.equal(document.report.totals.github.issuesOpened, 2000);
    assert.equal(document.report.totals.github.commits, 1000);
    assert.equal(document.report.totals.discord.messages, 1500);
    const report = { ...document.report, generatedAtMs: 0 };
    reports.push({
      period: `${period.period}/${period.key}`,
      github: report.totals.github.total,
      discord: report.totals.discord.messages,
      reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
      markdownSha256: createHash("sha256")
        .update(document.markdown.replace(/^Generated: .*$/m, "Generated: <time>."))
        .digest("hex"),
    });
  }
  console.log(
    JSON.stringify(
      {
        fixture: {
          issues: 2000,
          commits: 1000,
          messages: 1500,
          repos: 93,
          channels: 12,
          threads: 692,
        },
        measurement: {
          mode: workerMode ? "worker (startup included)" : "direct",
          durationMs,
          peakMainHeapDeltaMiB: (peakHeap - initialHeap) / 1024 ** 2,
          maxSyncCallbackMs,
          maxMainThreadTurnMs,
          callbackCount,
        },
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  monitoring.abort();
  hook.disable();
  await heartbeatDone;
  await runner?.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
