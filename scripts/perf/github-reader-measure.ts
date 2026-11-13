// Synthetic owner-boundary benchmark, not Gateway transport or real GitHub latency.
// node --trace-gc-nvp --import ./scripts/tsx.mjs scripts/perf/github-reader-measure.ts [samples=1000] [concurrency=2]
// Parse GC/promotion records only between BENCH_START and BENCH_END.
// --managed uses 40 real read identities sharing one synthetic managed profile.
// --warm reuses 20 primed targets; otherwise each operation refreshes a distinct PR.
// --owner=extensions/github/src/detail.<base>.ts compares a frozen owner with current source.
// --delay-ms=0 isolates local work; --delay-ms=200 adds realistic stubbed upstream latency.
// --allocations is a separate sampled-allocation pass; do not gate latency on that pass.
// Example: ... github-reader-measure.ts 3000 65 --managed --warm --delay-ms=0
// No network or native gh reads: all HTTP uses a synthetic transport. Fixture cleanup is automatic.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadGitHubDetail } from "../../extensions/github/api.js";
import type { ControlUiGitHubPreviewIdentity } from "../../extensions/github/src/preview-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const samples = Number(process.argv[2] ?? 1_000);
const concurrency = Number(process.argv[3] ?? 2);
assert(Number.isSafeInteger(samples) && samples > 0, "samples must be a positive integer");
assert(
  Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= samples,
  "concurrency must be a positive integer no greater than samples",
);
const args = process.argv.slice(4);
const option = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const requestDelayMs = Number(option("delay-ms") ?? 20);
assert(Number.isFinite(requestDelayMs) && requestDelayMs >= 0);
const managed = args.includes("--managed");
const warm = args.includes("--warm");
const allocations = args.includes("--allocations");
const owner = option("owner");
const readDetail: typeof loadGitHubDetail = owner
  ? (await import(pathToFileURL(path.resolve(owner)).href)).loadGitHubDetail
  : loadGitHubDetail;
type Timing = { waits: Array<[number, number]> };
const timings = new AsyncLocalStorage<Timing>();
let authorityCalls = 0;
let authorityMs = 0;
let upstreamMs = 0;
async function timed<T>(kind: "authMs" | "upstreamMs", work: () => Promise<T>): Promise<T> {
  const timing = timings.getStore();
  const started = performance.now();
  try {
    return await work();
  } finally {
    const finished = performance.now();
    const elapsed = finished - started;
    if (kind === "authMs") {
      authorityCalls++;
      authorityMs += elapsed;
    } else {
      upstreamMs += elapsed;
    }
    if (timing && kind === "upstreamMs") {
      timing.waits.push([started, finished]);
    }
  }
}
// Union awaited intervals: concurrent metadata requests must not be counted twice.
function blockedMs(waits: Timing["waits"]): number {
  let total = 0;
  let end = 0;
  for (const [start, finish] of waits.toSorted((left, right) => left[0] - right[0])) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}
const repositoryPath = "/repos/fixture/reader-benchmark";
const repositoryUrl = "https://github.com/fixture/reader-benchmark";
const date = "2026-01-01T00:00:00Z";
const body = "Synthetic discussion content. ".repeat(20).slice(0, 512);
const identity: ControlUiGitHubPreviewIdentity = {
  token: "test-only-placeholder",
  cacheScope: "synthetic-reader-benchmark",
  revalidate: () => timed("authMs", async () => {}),
  assertSelected: () => {},
};
let requests = 0;
const mockFetch: typeof fetch = (input, init) =>
  timed("upstreamMs", async () => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-placeholder");
    if (url.pathname === "/user") {
      return Response.json({ id: 123, login: "synthetic-reader", avatar_url: null });
    }
    requests += 1;
    if (requestDelayMs) {
      await delay(requestDelayMs, undefined, { signal: init?.signal ?? undefined });
    }
    if (url.pathname === repositoryPath) {
      return Response.json({ id: 123, private: false, visibility: "public" });
    }
    const match = /^\/repos\/fixture\/reader-benchmark\/(pulls|issues)\/(\d+)(\/comments)?$/u.exec(
      url.pathname,
    );
    assert(match, `Unexpected synthetic endpoint: ${url.pathname}`);
    const number = Number(match[2]);
    if (match[3]) {
      const review = match[1] === "pulls";
      return Response.json(
        Array.from({ length: 20 }, (_, index) => ({
          id: index + (review ? 21 : 1),
          html_url: `${repositoryUrl}/pull/${number}#${review ? "discussion_r" : "issuecomment-"}${index + 1}`,
          user: { login: `reviewer-${index}` },
          created_at: date,
          body,
          ...(review
            ? {
                path: "src/example.ts",
                line: 1,
                side: "RIGHT",
                diff_hunk: "@@ -1 +1 @@\n-old\n+new",
              }
            : {}),
        })),
      );
    }
    assert.equal(match[1], "pulls");
    return Response.json({
      title: "Synthetic pull request",
      body,
      user: { login: "fixture-author" },
      state: "open",
      created_at: date,
      updated_at: date,
      comments: 20,
      review_comments: 20,
      changed_files: 0,
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
    });
  });
const originalFetch = globalThis.fetch;
const inspector = new Session();
const gc: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push(entry.duration);
  }
});
let fixtureDir: string | undefined;
let inspectorConnected = false;
try {
  const identities: ControlUiGitHubPreviewIdentity[] = [];
  if (managed) {
    const { prepareGitHubReadIdentity, resolveManagedGitHubProfileDir } =
      await import("../../src/agents/github-tool-identity.js");
    const fixtureRoot = path.resolve(".local");
    await fs.mkdir(fixtureRoot, { recursive: true });
    fixtureDir = await fs.mkdtemp(path.join(fixtureRoot, "github-reader-measure-"));
    const env = { OPENCLAW_STATE_DIR: fixtureDir };
    const profileId = `ghp_${"1".repeat(32)}`;
    const config: OpenClawConfig = {
      tools: { github: { profileId } },
      agents: {
        entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`agent-${i}`, {}])),
      },
    };
    const directory = resolveManagedGitHubProfileDir({
      agentId: "",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, "hosts.yml"),
      "github.com:\n  oauth_token: test-only-placeholder\n",
      { mode: 0o600 },
    );
    globalThis.fetch = mockFetch;
    for (let i = 0; i < 40; i++) {
      const prepared = await prepareGitHubReadIdentity({
        config,
        agentId: `agent-${i}`,
        env,
        getCurrentConfig: () => config,
        assertActive() {},
        refresh: async () => {},
      });
      const revalidate = prepared.revalidate;
      prepared.revalidate = () => timed("authMs", revalidate);
      identities.push(prepared);
    }
  } else {
    identities.push(identity);
  }
  const references = Array.from(
    { length: 10_000 },
    (_, index) => identities[index % identities.length]!,
  );
  let sequence = 0;
  let localMs = 0;
  let serializationMs = 0;
  const responseDigests: string[] = [];
  async function read() {
    const operation = sequence++;
    const number = warm ? (operation % 20) + 1 : operation + 1;
    const timing: Timing = { waits: [] };
    return timings.run(timing, async () => {
      const startedAt = performance.now();
      const result = await readDetail(
        { owner: "fixture", repo: "reader-benchmark", kind: "pull", number },
        references[operation % references.length],
        mockFetch,
        !warm,
        "discussion",
      );
      const elapsed = performance.now() - startedAt;
      assert.equal(result.url, `${repositoryUrl}/pull/${number}`);
      assert.equal(result.comments?.length, 40);
      assert.equal(result.commentsTotal, 40);
      assert.equal(result.partial, false);
      assert(result.comments?.every((comment) => comment.body === body));
      localMs += Math.max(0, elapsed - blockedMs(timing.waits));
      const serializeStarted = performance.now();
      const serialized = JSON.stringify(result);
      serializationMs += performance.now() - serializeStarted;
      responseDigests[operation] = createHash("sha256").update(serialized).digest("hex");
      return elapsed;
    });
  }
  for (let index = 0; index < (warm ? 20 : 10); index += 1) {
    await read();
  }
  requests = authorityCalls = authorityMs = upstreamMs = localMs = serializationMs = 0;
  responseDigests.length = 0;
  sequence = warm ? 0 : 10;
  if (allocations) {
    inspector.connect();
    inspectorConnected = true;
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const latencies: number[] = [];
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let maxRssBytes = process.memoryUsage.rss();
  let next = 0;
  console.log("BENCH_START");
  observer.observe({ entryTypes: ["gc"] });
  const cpuStart = process.cpuUsage();
  const threadCpuStart = process.threadCpuUsage();
  const startedAt = performance.now();
  loop.enable();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < samples) {
        latencies.push(await read());
        maxRssBytes = Math.max(maxRssBytes, process.memoryUsage.rss());
      }
    }),
  );
  loop.disable();
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = process.threadCpuUsage(threadCpuStart);
  const sampledBytes = allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  console.log("BENCH_END");
  await new Promise<void>((done) => {
    setImmediate(done);
  });
  observer.disconnect();
  assert.equal(latencies.length, samples);
  assert.equal(requests, samples * (warm ? 1 : 5));
  latencies.sort((left, right) => left - right);
  const percentile = (fraction: number) => latencies[Math.ceil(samples * fraction) - 1];
  console.log(
    JSON.stringify({
      samples,
      concurrency,
      managed,
      warm,
      owner: owner ?? "current",
      identityCount: identities.length,
      sessionReferences: references.length,
      hostLoad,
      hostLoadAfter: loadavg(),
      responseDigest: createHash("sha256").update(responseDigests.join("\n")).digest("hex"),
      authorityCalls,
      authorityCallsPerOperation: authorityCalls / samples,
      authorityMsPerOperation: authorityMs / samples,
      upstreamMsPerOperation: upstreamMs / samples,
      localMsPerOperation: localMs / samples,
      serializationMsPerOperation: serializationMs / samples,
      timingNote:
        "Authority and upstream durations sum overlapping calls; local time includes authority and excludes the upstream interval union.",
      sampledBytes,
      sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / samples,
      mainThreadCpuMsPerOperation: (threadCpu.user + threadCpu.system) / 1_000 / samples,
      requestDelayMs,
      elapsedMs,
      gcMs: gc.reduce((sum, duration) => sum + duration, 0),
      maxGcMs: Math.max(0, ...gc),
      requests,
      requestsPerOperation: requests / samples,
      latencyMs: {
        count: samples,
        mean: latencies.reduce((sum, value) => sum + value, 0) / samples,
        median: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
      cpuMsPerOperation: (cpu.user + cpu.system) / 1_000 / samples,
      rssBytes: process.memoryUsage.rss(),
      maxRssBytes,
      heapUsedBytes: process.memoryUsage().heapUsed,
      eventLoopMs: { count: loop.count, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    }),
  );
} finally {
  observer.disconnect();
  globalThis.fetch = originalFetch;
  if (inspectorConnected) {
    inspector.disconnect();
  }
  if (fixtureDir) {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
}
