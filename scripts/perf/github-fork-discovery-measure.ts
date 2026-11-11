/**
 * Fork-discovery owner measurement with a recording loopback GitHub server.
 * node --import ./scripts/tsx.mjs scripts/perf/github-fork-discovery-measure.ts <owner-module.ts> [1000] [--etag] [--allocations]
 * Baseline module copies must be adjacent to control-ui-session-prs.ts.
 * Add --compare=<candidate-module.ts> for A/A controls then five serial AB/BA pairs.
 * Timing and allocation passes stay separate.
 * Acceptance: identical PR facts, two identical list requests become one, lower CPU/allocation.
 * ETag mode must preserve 304 reuse; its response-body allocation is already zero when warm.
 * Includes loopback server CPU/allocation. Uses prepared repository contexts, not a Gateway or Git fixture.
 * 10,000 session identities exceed the branch cache; one owner has an origin and a renamed fork.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";

const ownerPath = process.argv[2];
assert(ownerPath);
const iterations = Number(process.argv[3] ?? 1000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const etag = process.argv.includes("--etag");
const allocations = process.argv.includes("--allocations");
const candidatePath = process.argv.find((arg) => arg.startsWith("--compare="))?.slice(10);
const owners = await Promise.all(
  [ownerPath, ...(candidatePath ? [candidatePath] : [])].map(async (path) => ({
    path,
    load: (await import(pathToFileURL(resolve(path)).href)).loadControlUiSessionPullRequests,
  })),
);
let selectedOwner = owners[0]!;
setRuntimeConfigSnapshot({
  gateway: { controlUi: { github: { host: "github.com", token: "synthetic-fork-measure" } } },
});
const payload = JSON.stringify(
  Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    title: `Synthetic fork change ${index + 1}`,
    body: "Synthetic pull-request description. ".repeat(120),
    html_url: `https://github.com/synthetic/project/pull/${index + 1}`,
    state: "closed",
    merged_at: "2026-10-01T00:00:00Z",
    head: {
      sha: (index + 1).toString(16).padStart(40, "0"),
      ref: "feature",
      repo: { full_name: "synthetic/renamed-fork" },
    },
    base: { ref: "main", repo: { name: "project", owner: { login: "synthetic" } } },
  })),
);
let counts = { requests: 0, fullResponses: 0, notModified: 0, bytes: 0 };
const server = createServer((request, response) => {
  counts.requests++;
  assert.equal(
    request.url,
    "/repos/synthetic/project/pulls?head=synthetic%3Afeature&state=all&sort=updated&direction=desc&per_page=5",
  );
  assert.equal(request.headers.authorization, "Bearer synthetic-fork-measure");
  if (etag) {
    response.setHeader("etag", '"synthetic-v1"');
  }
  if (etag && request.headers["if-none-match"] === '"synthetic-v1"') {
    counts.notModified++;
    response.writeHead(304).end();
  } else {
    counts.fullResponses++;
    counts.bytes += Buffer.byteLength(payload);
    response.writeHead(200, { "content-type": "application/json" }).end(payload);
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  assert.equal(url.origin, "https://api.github.com");
  return nativeFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
};
const read = async (index: number) => {
  const sessionKey = `agent:main:synthetic-fork-${index % 10000}`;
  const result = await selectedOwner.load(
    { sessionKey },
    {
      read: {
        target: {
          params: { sessionKey, agentId: "main" },
          identity: sessionKey,
          readSource: { agentId: "main", path: "/synthetic/agent.db" },
          source: {
            owner: "synthetic",
            repo: "project",
            branch: "feature",
            forkHeadCandidates: [{ owner: "synthetic", repo: "renamed-fork" }],
          },
        },
        sourceIdentity: "synthetic-owner",
        projection: "publication",
        assertCurrent: () => {},
      },
    },
  );
  assert.deepEqual(
    result.pullRequests.map((pr: { number: number }) => pr.number),
    [1, 2, 3, 4, 5],
  );
  assert.equal(result.rateLimited, false);
};
const inspector = new Session();
try {
  if (allocations) {
    inspector.connect();
  }
  for (const owner of owners) {
    selectedOwner = owner;
    for (let index = 0; index < Math.min(iterations, 1000); index++) {
      await read(index);
    }
  }
  const arms = candidatePath
    ? [
        { owner: 0, pair: "control" },
        { owner: 0, pair: "control" },
        ...Array.from({ length: 5 }, (_, pair) =>
          (pair % 2 ? [1, 0] : [0, 1]).map((owner) => ({ owner, pair: String(pair + 1) })),
        ).flat(),
      ]
    : [{ owner: 0, pair: "single" }];
  for (const arm of arms) {
    selectedOwner = owners[arm.owner]!;
    for (let index = 0; index < 32; index++) {
      await read(index);
    }
    counts = { requests: 0, fullResponses: 0, notModified: 0, bytes: 0 };
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const latencies: number[] = [];
    const hostLoad = loadavg();
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      const callStarted = performance.now();
      await read(index + 32);
      latencies.push(performance.now() - callStarted);
    }
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const profile = allocations
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    let sampledBytes = 0;
    let jsonBodySampledBytes = 0;
    const nodes = profile ? [{ node: profile.head, withinReader: false }] : [];
    while (nodes.length) {
      const { node, withinReader } = nodes.pop()!;
      const selected = withinReader || node.callFrame.functionName === "readGitHubJsonBody";
      sampledBytes += node.selfSize;
      if (selected) {
        jsonBodySampledBytes += node.selfSize;
      }
      nodes.push(...node.children.map((child) => ({ node: child, withinReader: selected })));
    }
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        ownerPath: selectedOwner.path,
        pair: arm.pair,
        iterations,
        etag,
        allocations,
        hostLoad,
        elapsedMs,
        payloadBytes: Buffer.byteLength(payload),
        ...counts,
        requestsPerRead: counts.requests / iterations,
        bytesPerRead: counts.bytes / iterations,
        cpuUsPerRead: (used.user + used.system) / iterations,
        sampledBytesPerRead: profile ? sampledBytes / iterations : undefined,
        jsonBodySampledBytesPerRead: profile ? jsonBodySampledBytes / iterations : undefined,
        medianMs: latencies[Math.floor(iterations / 2)],
        p95Ms: latencies[Math.ceil(iterations * 0.95) - 1],
      }),
    );
  }
} finally {
  if (allocations) {
    inspector.disconnect();
  }
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise<void>((done, fail) => {
    server.close((error) => (error ? fail(error) : done()));
  });
}
