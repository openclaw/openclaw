/**
 * Synthetic GitHub reader retention through the plugin API. No network or credentials.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/github-detail-retention.ts [baseline-detail.ts]
 * Freeze a baseline with git show BASE:extensions/github/src/detail.ts > baseline-detail.ts.
 * Run five serial A/B pairs plus A/A. Accept identical documents/request counts,
 * collection of complete-document raw responses, and lower post-GC retained heap.
 * ETags are absent to isolate the document cache from the separate bounded ETag cache.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";

assert(global.gc, "Use --expose-gc");
const ownerUrl = new URL("../../extensions/github/src/detail.ts", import.meta.url);
const source = readFileSync(process.argv[2] ? resolve(process.argv[2]) : ownerUrl, "utf8");
registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { loadGitHubDetail } = await import("../../extensions/github/api.js");
const payload = {
  title: "Synthetic issue",
  body: "A small document body.",
  user: { login: "synthetic" },
  state: "open",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  comments: 0,
  labels: Array.from({ length: 40 }, (_, id) => ({
    id,
    name: `label-${id}`,
    color: "abcdef",
    url: `https://api.github.com/repos/synthetic/fixture/labels/label-${id}`,
    description: "Synthetic label description. ".repeat(8),
  })),
};
const body = JSON.stringify(payload);
const refs: WeakRef<object>[] = [];
let requests = 0;
const fetcher: typeof fetch = async (input) => {
  requests++;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new Response(
    url.includes("/issues/")
      ? body
      : JSON.stringify({ id: 1, private: false, visibility: "public" }),
  );
};
const read = (number: number) =>
  loadGitHubDetail(
    { kind: "issue", owner: "synthetic", repo: "fixture", number },
    undefined,
    fetcher,
  );
async function collect() {
  for (let i = 0; i < 4; i++) {
    await nextTurn();
    global.gc?.();
  }
}
await read(1);
await collect();
const beforeHeap = process.memoryUsage().heapUsed;
const beforeCpu = process.cpuUsage();
const beforeAllocated = getHeapStatistics().total_allocated_bytes;
const beforeTime = performance.now();
const digest = createHash("sha256");
for (let i = 2; i <= 2048; i++) {
  const result = await read(i);
  assert.equal(result.body, payload.body);
  assert.equal(result.title, payload.title);
  digest.update(JSON.stringify(result));
}
const cpu = process.cpuUsage(beforeCpu);
const metrics = {
  elapsedMs: performance.now() - beforeTime,
  cpuMs: (cpu.user + cpu.system) / 1000,
  allocatedBytes: getHeapStatistics().total_allocated_bytes - beforeAllocated,
};
await collect();
const afterHeap = process.memoryUsage().heapUsed;
// Observe freshly parsed response objects outside the timing/allocation interval.
const parse = JSON.parse;
JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
  const value: unknown = parse(text, reviver);
  if (text === body && value !== null && typeof value === "object") {
    refs.push(new WeakRef(value));
  }
  return value;
};
try {
  for (let i = 2049; i <= 2080; i++) {
    await read(i);
  }
} finally {
  JSON.parse = parse;
}
await collect();
const liveRawResponses = refs.filter((ref) => ref.deref() !== undefined).length;
assert.equal(refs.length, 32);
const beforeCached = requests;
assert.equal((await read(2080)).body, payload.body);
assert.equal(requests, beforeCached, "Rendered document reuse must not add requests");
console.log(
  JSON.stringify({
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    bodyBytes: Buffer.byteLength(body),
    documents: 2080,
    requests,
    beforeHeap,
    afterHeap,
    retainedDelta: afterHeap - beforeHeap,
    liveRawResponses,
    digest: digest.digest("hex"),
    ...metrics,
    load: loadavg(),
  }),
);
