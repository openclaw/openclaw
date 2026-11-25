/**
 * Publication recovery owner benchmark; no live Gateway, credentials or GitHub traffic.
 * node --import ./scripts/tsx.mjs scripts/perf/github-publication-read-measure.ts <prs-module> <relevance-module> [5000] [--allocations] [--slow-details]
 * Baseline overrides must be adjacent to their source owners for relative imports.
 * Run base/candidate interleaved. Reads select from a 10k-session identity space and 40 branches;
 * 65 concurrent readers consume lists with three open PRs and a fourth merged PR.
 * Acceptance: identical recovery facts, no display-detail requests for publication,
 * lower CPU/allocation per read, and p95 below 1s with 1.2s optional detail responses.
 * Timing and allocation sampling run separately. Cold list misses are intentional;
 * repeated immutable-head coverage is measured in the same flow. This is owner proof,
 * not whole-Gateway or live GitHub latency. --slow-details uses 260 reads.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";

const [prsPath, relevancePath, requestedIterations] = process.argv.slice(2);
assert(prsPath && relevancePath);
const slowDetails = process.argv.includes("--slow-details");
const allocations = process.argv.includes("--allocations");
const iterations = slowDetails ? 260 : Number(requestedIterations ?? 5000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const { loadControlUiSessionPullRequests } = await import(pathToFileURL(resolve(prsPath)).href);
const { isGitHubPublicationSuperseded } = await import(pathToFileURL(resolve(relevancePath)).href);
setRuntimeConfigSnapshot({
  gateway: { controlUi: { github: { host: "github.com", token: "synthetic-publication-bench" } } },
});
const tree = "b".repeat(40);
const source = "c".repeat(40);
const requests = { list: 0, details: 0, checks: 0, commit: 0, comparison: 0 };
const response = (body: unknown) => Response.json(body);
globalThis.fetch = async (input) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  assert.equal(url.hostname, "api.github.com");
  if (url.pathname.endsWith("/pulls")) {
    requests.list++;
    const branch = url.searchParams.get("head")!.split(":").slice(1).join(":");
    const branchIndex = Number(branch.split("-").at(-1));
    const head = (branchIndex + 1).toString(16).padStart(40, "0");
    return response(
      [0, 1, 2, 3].map((offset) => ({
        number: branchIndex * 4 + offset + 1,
        title: `Synthetic change ${branchIndex}/${offset}`,
        html_url: `https://github.com/synthetic/project/pull/${branchIndex * 4 + offset + 1}`,
        state: offset === 3 ? "closed" : "open",
        merged_at: offset === 3 ? "2026-10-01T00:00:00Z" : null,
        head: { sha: head, ref: branch },
        base: {
          ref: ["main", "stable", "next", "main"][offset],
          repo: { name: "project", owner: { login: "synthetic" } },
        },
      })),
    );
  }
  if (url.pathname.includes("/git/commits/")) {
    requests.commit++;
    return response({ sha: url.pathname.split("/").at(-1), tree: { sha: tree } });
  }
  if (url.pathname.includes("/compare/")) {
    requests.comparison++;
    return response({
      status: "ahead",
      base_commit: { sha: source, commit: { tree: { sha: tree } } },
      merge_base_commit: { sha: source },
    });
  }
  if (url.pathname.includes("/pulls/")) {
    requests.details++;
    if (slowDetails) {
      await delay(1200);
    }
    return response({ additions: 125, deletions: 52, changed_files: 8 });
  }
  if (url.pathname.endsWith("/check-runs") || url.pathname.endsWith("/status")) {
    requests.checks++;
    if (slowDetails) {
      await delay(1200);
    }
    return response(
      url.pathname.endsWith("/status")
        ? { state: "success", statuses: [] }
        : {
            total_count: 100,
            check_runs: Array.from({ length: 100 }, (_, id) => ({
              id,
              name: `check-${id}`,
              status: "completed",
              conclusion: "success",
            })),
          },
    );
  }
  throw new Error(`Unexpected synthetic GitHub route: ${url.pathname}`);
};
const latencies: number[] = [];
const assertCurrent = () => {};
async function read(index: number) {
  const sessionKey = `agent:main:synthetic-${index % 10000}`;
  const branch = `feature-${index % 40}`;
  const started = performance.now();
  const result = await loadControlUiSessionPullRequests(
    { sessionKey },
    {
      read: {
        target: {
          params: { sessionKey, agentId: "main" },
          identity: sessionKey,
          readSource: { agentId: "main", path: "/synthetic/agent.db" },
          source: { owner: "synthetic", repo: "project", branch },
        },
        sourceIdentity: "synthetic-owner",
        projection: "publication",
        assertCurrent,
      },
    },
  );
  assert.equal(result.pullRequests.length, 4);
  assert.equal(result.rateLimited, false);
  assert.equal(
    await isGitHubPublicationSuperseded(
      {
        repository: "synthetic/project",
        branch,
        source_head_commit: source,
        workspace_tree: tree,
      },
      async () => ({ pullRequests: result.pullRequests, assertCurrent }),
    ),
    true,
  );
  latencies.push(performance.now() - started);
}
const inspector = new Session();
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
if (allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpu = process.cpuUsage();
const mainThreadCpu = process.threadCpuUsage();
const started = performance.now();
for (let first = 0; first < iterations; first += 65) {
  await Promise.all(
    Array.from({ length: Math.min(65, iterations - first) }, (_, offset) => read(first + offset)),
  );
}
const elapsedMs = performance.now() - started;
const used = process.cpuUsage(cpu);
const mainThreadUsed = process.threadCpuUsage(mainThreadCpu);
const sampledBytes = allocations
  ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
      (sum, row) => sum + row.size,
      0,
    )
  : undefined;
await new Promise<void>((done) => {
  setImmediate(done);
});
await delay(0);
latencies.sort((a, b) => a - b);
const memory = process.memoryUsage();
observer.disconnect();
let retainedHeapBytes: number | undefined;
if (global.gc) {
  global.gc();
  retainedHeapBytes = process.memoryUsage().heapUsed;
}
console.log(
  JSON.stringify({
    prsPath,
    relevancePath,
    iterations,
    allocations,
    slowDetails,
    hostLoad,
    elapsedMs,
    requests,
    cpuUsPerRead: (used.user + used.system) / iterations,
    mainThreadCpuUsPerRead: (mainThreadUsed.user + mainThreadUsed.system) / iterations,
    sampledBytesPerRead: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    medianMs: latencies[Math.floor(iterations / 2)],
    p95Ms: latencies[Math.ceil(iterations * 0.95) - 1],
    gcMs,
    ...memory,
    retainedHeapBytes,
  }),
);
inspector.disconnect();
