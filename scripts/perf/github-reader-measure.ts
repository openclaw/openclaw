// Synthetic owner-boundary benchmark, not Gateway transport or real GitHub latency.
// node --trace-gc-nvp --import ./scripts/tsx.mjs scripts/perf/github-reader-measure.ts [samples=1000] [concurrency=2]
// Parse GC/promotion records only between BENCH_START and BENCH_END.
import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { loadGitHubDetail } from "../../extensions/github/api.js";

const samples = Number(process.argv[2] ?? 1_000);
const concurrency = Number(process.argv[3] ?? 2);
assert(Number.isSafeInteger(samples) && samples > 0, "samples must be a positive integer");
assert(
  Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= samples,
  "concurrency must be a positive integer no greater than samples",
);
const requestDelayMs = 20;
const repositoryPath = "/repos/fixture/reader-benchmark";
const repositoryUrl = "https://github.com/fixture/reader-benchmark";
const date = "2026-01-01T00:00:00Z";
const body = "Synthetic discussion content. ".repeat(20).slice(0, 512);
const identity = {
  token: "test-only-placeholder",
  cacheScope: "synthetic-reader-benchmark",
  revalidate: async () => {},
  assertSelected: () => {},
};
let requests = 0;
const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-placeholder");
  requests += 1;
  await delay(requestDelayMs, undefined, { signal: init?.signal ?? undefined });
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
          ? { path: "src/example.ts", line: 1, side: "RIGHT", diff_hunk: "@@ -1 +1 @@\n-old\n+new" }
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
};
let sequence = 0;
async function read() {
  const number = ++sequence;
  const startedAt = performance.now();
  const result = await loadGitHubDetail(
    { owner: "fixture", repo: "reader-benchmark", kind: "pull", number },
    identity,
    mockFetch,
    true,
    "discussion",
  );
  const elapsed = performance.now() - startedAt;
  assert.equal(result.url, `${repositoryUrl}/pull/${number}`);
  assert.equal(result.comments?.length, 40);
  assert.equal(result.commentsTotal, 40);
  assert.equal(result.partial, false);
  assert(result.comments?.every((comment) => comment.body === body));
  return elapsed;
}
for (let index = 0; index < 10; index += 1) {
  await read();
}
requests = 0;
const latencies: number[] = [];
const loop = monitorEventLoopDelay({ resolution: 1 });
let maxRssBytes = process.memoryUsage.rss();
let next = 0;
console.log("BENCH_START");
const cpuStart = process.cpuUsage();
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
console.log("BENCH_END");
assert.equal(latencies.length, samples);
assert.equal(requests, samples * 5);
latencies.sort((left, right) => left - right);
const percentile = (fraction: number) => latencies[Math.ceil(samples * fraction) - 1];
console.log(
  JSON.stringify({
    samples,
    concurrency,
    requestDelayMs,
    elapsedMs,
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
    eventLoopMs: { count: loop.count, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
  }),
);
