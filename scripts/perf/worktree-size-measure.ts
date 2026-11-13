// Run: node --import ./scripts/tsx.mjs scripts/perf/worktree-size-measure.ts
// Add --allocation for a separate sampled-heap allocation pass; --iterations
// defaults to 2,000. --base-file <saved-capacity.runtime.ts> loads the saved owner
// through the current import graph. Run base/candidate in alternating order.
// Exercises the real checkout-size owner across advancing commits, alternating
// one file's size among 10,000 complete files. Twenty warmups fill its existing
// cache. A synthetic Git adapter copies each output
// buffer as a real subprocess boundary would; fixture construction is excluded.
// Reports owner + adapter JS CPU/sampled heap, copied output-buffer bytes, and
// command counts separately. Excludes native Git CPU, filesystem/network I/O,
// worker queues, and Gateway latency. Use the dev Gateway phase run for those.
// --repo <task-owned-synthetic-clone> instead runs native Git against HEAD,
// defaults to one iteration, and skips warmup to include first hydration. Its
// wall time includes Git/I/O; process CPU excludes native Git child CPU. Use a
// fresh clone per arm for partial-clone comparisons. No operator repositories.
// --previous-ref <commit> seeds the native cache before timing; its initial
// hydration/size scan is excluded. Without it, native mode measures a cold HEAD.
// --hydration-base-file <saved-object-hydration.ts> compares the hydration owner
// independently against the same native fixture and checkout-size implementation.
// --cold disables size-fact reuse to measure a cold Git worker on every operation.
// Acceptance: identical byte totals, fewer full scans, lower CPU/allocation.
// --hydrate-objects <OID file> --ref <commit> isolates the explicit hydration owner,
// including stale-batch replays with --iterations. --concurrent submits two callers.
// --transport-base-file compares saved base-fetch.ts; --allow-failure reports
// failed launches as failures with timing/allocation, never as successful hydration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    allocation: { type: "boolean" },
    cold: { type: "boolean" },
    "base-file": { type: "string" },
    "hydration-base-file": { type: "string" },
    "transport-base-file": { type: "string" },
    "allow-failure": { type: "boolean" },
    iterations: { type: "string" },
    repo: { type: "string" },
    "previous-ref": { type: "string" },
    "hydrate-objects": { type: "string" },
    ref: { type: "string" },
    concurrent: { type: "boolean" },
  },
});
const repo = values.repo ? path.resolve(values.repo) : undefined;
assert(!values["previous-ref"] || repo, "previous-ref requires repo");
assert(!values.cold || !values["previous-ref"], "cold cannot seed a previous fact");
assert(!values["hydrate-objects"] || (repo && values.ref), "hydration requires repo and ref");
assert(!values.concurrent || values["hydrate-objects"], "concurrent requires hydration");
const hydrateObjects = values["hydrate-objects"]
  ? (await fs.readFile(values["hydrate-objects"], "utf8")).trim().split("\n")
  : undefined;
const iterations = Number(values.iterations ?? (repo ? "1" : "2000"));
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be a positive integer");
const fileCount = 10_000;
const treeCount = 101;
const sizes = Array.from({ length: fileCount }, (_, index) => (index * 7919) % 131_072);
const expectedBytes = sizes.reduce(
  (sum, size) => sum + Math.max(4096, Math.ceil(size / 4096) * 4096),
  0,
);
const counts = () => ({
  resolve: 0,
  replacements: 0,
  inventory: 0,
  fullSize: 0,
  diff: 0,
  blobSizeBatch: 0,
});
const state = {
  operation: 0,
  inventory: `${Array.from({ length: fileCount + treeCount + 1 }, (_, index) => (index + 1).toString(16).padStart(40, "0")).join("\n")}\n`,
  sizes: [0, 9000].map((firstSize) => `${[firstSize, ...sizes.slice(1)].join("\n")}\n`),
  counts: counts(),
  copiedOutputBufferBytes: 0,
};
const syntheticRoot = repo
  ? undefined
  : await fs.mkdtemp(path.join(tmpdir(), "worktree-size-measure-"));
const stateKey = Symbol.for("openclaw.perf.worktree-size-measure");
Object.defineProperty(globalThis, stateKey, { value: state, configurable: true });
const ownerUrl = new URL("../../src/agents/worktrees/capacity.runtime.ts", import.meta.url).href;
const gitUrl = new URL("../../src/agents/worktrees/git.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
const hydrationUrl = new URL("../../src/agents/worktrees/object-hydration.ts", import.meta.url)
  .href;
const hydrationBaseUrl = values["hydration-base-file"]
  ? pathToFileURL(path.resolve(values["hydration-base-file"])).href
  : undefined;
const transportUrl = new URL("../../src/agents/worktrees/base-fetch.ts", import.meta.url).href;
const transportBaseUrl = values["transport-base-file"]
  ? pathToFileURL(path.resolve(values["transport-base-file"])).href
  : undefined;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (!repo && url === gitUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
const state = globalThis[Symbol.for("openclaw.perf.worktree-size-measure")];
export const WORKTREE_CHECKOUT_TIMEOUT_MS = 300000;
const blobIds = ["b".repeat(40), "c".repeat(40)];
function output(args, options) {
  if (args[0] === "rev-parse") {
    state.counts.resolve++;
    return state.operation.toString(16).padStart(40, "0") + "\\n";
  }
  if (args[0] === "for-each-ref") {
    state.counts.replacements++;
    return "";
  }
  if (args[0] === "rev-list") {
    state.counts.inventory++;
    return state.inventory;
  }
  if (args[0] === "ls-tree") {
    state.counts.fullSize++;
    return state.sizes[state.operation % 2];
  }
  if (args[0] === "diff-tree") {
    state.counts.diff++;
    const commits = args.filter((arg) => /^[0-9a-f]{40}$/.test(arg));
    if (commits.length !== 2) throw new Error("Expected two immutable diff commits");
    const [oldBlob, newBlob] = commits.map((commit) => blobIds[Number.parseInt(commit, 16) % 2]);
    return oldBlob === newBlob ? "" : ":100644 100644 " + oldBlob + " " + newBlob + " M\\0fixture.txt\\0";
  }
  if (args[0] === "cat-file") {
    state.counts.blobSizeBatch++;
    return Buffer.from(options.input).toString("utf8").trimEnd().split("\\n").map((oid) => {
      if (!blobIds.includes(oid)) throw new Error("Unexpected changed blob: " + oid);
      return "blob " + (oid === blobIds[0] ? 0 : 9000);
    }).join("\\n") + "\\n";
  }
  throw new Error("Unexpected synthetic Git command: " + JSON.stringify(args));
}
export async function runGitBuffered(_cwd, args, options = {}) {
  const stdout = Buffer.from(output(args, options), "utf8");
  state.copiedOutputBufferBytes += stdout.byteLength;
  return { termination: "exit", code: 0, stdout, stderr: Buffer.alloc(0) };
}
export async function requireGitBuffer(cwd, args, options) {
  return (await runGitBuffered(cwd, args, options)).stdout;
}
export async function runGit(cwd, args, options) {
  const result = await runGitBuffered(cwd, args, options);
  return { ...result, stdout: result.stdout.toString("utf8"), stderr: "" };
}
export async function requireGit(cwd, args, options) {
  return (await runGit(cwd, args, options)).stdout.trim();
}
`,
      };
    }
    return nextLoad(
      url === ownerUrl && baseUrl
        ? baseUrl
        : url === hydrationUrl && hydrationBaseUrl
          ? hydrationBaseUrl
          : url === transportUrl && transportBaseUrl
            ? transportBaseUrl
            : url,
      context,
    );
  },
});
const inspector = new Session();
try {
  const { estimateCheckoutObjectBytes } =
    await import("../../src/agents/worktrees/capacity.runtime.js");
  const { hydrateCommitObjects } = await import("../../src/agents/worktrees/object-hydration.js");
  let actualCheckoutBytes: number | undefined;
  if (repo && values["previous-ref"]) {
    await estimateCheckoutObjectBytes(repo, values["previous-ref"], "refs/replace/");
  }
  const measure = async () => {
    state.operation++;
    if (hydrateObjects) {
      const hydrate = () => hydrateCommitObjects(repo!, values.ref!, hydrateObjects);
      await (values.concurrent ? Promise.all([hydrate(), hydrate()]) : hydrate());
      return;
    }
    actualCheckoutBytes = await estimateCheckoutObjectBytes(
      repo ?? syntheticRoot!,
      "HEAD",
      values.cold ? undefined : "refs/replace/",
    );
    if (!repo) {
      assert.equal(actualCheckoutBytes, expectedBytes + (state.operation % 2) * 8192);
    }
  };
  for (let index = 0; index < (repo ? 0 : 20); index++) {
    await measure();
  }
  state.counts = counts();
  state.copiedOutputBufferBytes = 0;
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [];
  const failures: string[] = [];
  const loadBefore = loadavg();
  const cpuStart = process.cpuUsage();
  const allocatedStart = getHeapStatistics().total_allocated_bytes;
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const operationStart = performance.now();
    try {
      await measure();
    } catch (error) {
      if (!values["allow-failure"]) {
        throw error;
      }
      failures.push(error instanceof Error ? error.message : String(error));
    }
    samples.push(performance.now() - operationStart);
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedStart;
  let sampledHeapBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    sampledHeapBytes = bytes(profile.head);
  }
  const sortedSamples = samples.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      revision: baseUrl || hydrationBaseUrl || transportBaseUrl ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      scope: repo
        ? "direct owner with native Git; wall includes Git/I/O, process CPU excludes Git child CPU; optional seed excluded"
        : `${values.cold ? "cold" : "advancing-commit"} JS owner and synthetic Git adapter; excludes native Git, network, and worker queues`,
      operations: iterations,
      failures,
      hydrationObjects: hydrateObjects?.length,
      concurrent: Boolean(values.concurrent),
      samplesMs: hydrateObjects ? samples : undefined,
      allocatedBytesPerOperation: Number.isFinite(allocatedBytes)
        ? allocatedBytes / iterations
        : undefined,
      cold: Boolean(values.cold),
      previousRef: values["previous-ref"],
      seedExcluded: Boolean(values["previous-ref"]),
      fileCount: repo ? undefined : fileCount,
      treeCount: repo ? undefined : treeCount,
      actualCheckoutBytes,
      expectedCheckoutBytes: repo ? undefined : expectedBytes + (state.operation % 2) * 8192,
      commandCounts: repo ? undefined : state.counts,
      wallMs,
      p50Ms: sortedSamples[Math.ceil(samples.length * 0.5) - 1],
      p95Ms: sortedSamples[Math.ceil(samples.length * 0.95) - 1],
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      sampledHeapBytesPerOperation:
        sampledHeapBytes === undefined ? undefined : sampledHeapBytes / iterations,
      copiedOutputBufferBytesPerOperation: repo
        ? undefined
        : state.copiedOutputBufferBytes / iterations,
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, stateKey);
  if (syntheticRoot) {
    await fs.rm(syntheticRoot, { recursive: true });
  }
}
