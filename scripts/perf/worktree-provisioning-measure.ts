/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-measure.ts --iterations 2000
 * Add --base-file <saved-provisioned-files.ts>; alternate base/candidate timing arms.
 * Real copy owner, provisioning inspection and parent-path checks; 256 ignored files.
 * Synthetic Git, stat and copy adapters isolate JS orchestration and exact V8
 * allocation. Native Git, filesystem I/O, worker IPC, capacity admission and Gateway
 * latency are excluded; measure those separately through a native dev Gateway.
 * Acceptance: identical copied paths, mode-preservation and authority checks, zero unused
 * size-estimation stats during copying, less allocation/CPU without a material tail
 * regression. Natural GC only; process RSS/heap and host load are context.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import type { GitWorktreeOperation } from "../../src/agents/worktrees/git-worktree-operations.js";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../src/agents/worktrees/provisioned-files.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
const sourceRoot = path.resolve(".local/worktree-provisioning-fixture/source");
const destinationRoot = path.resolve(".local/worktree-provisioning-fixture/destination");
const paths = Array.from(
  { length: 256 },
  (_, i) => `ignored/config/package-${String(i).padStart(3, "0")}/nested/settings.local`,
);
const counts = () => ({
  git: 0,
  manifest: 0,
  inspectionParentStats: 0,
  inspectionFileStats: 0,
  copyParentStats: 0,
  copySourceStats: 0,
  copyDestinationStats: 0,
  copies: 0,
  authorityChecks: 0,
});
let inspecting = false;
let copied: string[] = [];
let counters = counts();
const fileStat = () => ({
  size: 4096,
  mode: 0o100640,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
});
const syntheticFs = {
  async stat(target: string) {
    assert.equal(target, path.join(sourceRoot, ".worktreeinclude"));
    counters.manifest++;
    return fileStat();
  },
  async lstat(target: string) {
    const source = target.startsWith(sourceRoot + path.sep);
    assert(source || target.startsWith(destinationRoot + path.sep));
    if (target.endsWith("settings.local")) {
      if (source) {
        counters[inspecting ? "inspectionFileStats" : "copySourceStats"]++;
        return fileStat();
      }
      counters.copyDestinationStats++;
      throw Object.assign(new Error("synthetic absent destination"), { code: "ENOENT" });
    }
    counters[inspecting ? "inspectionParentStats" : "copyParentStats"]++;
    return { ...fileStat(), isDirectory: () => true, isFile: () => false };
  },
};
const state = {
  fs: syntheticFs,
  async git(_root: string, args: string[]) {
    assert.equal(_root, sourceRoot);
    assert(args.includes("ls-files") && args.includes("--ignored"));
    counters.git++;
    const selected = args.includes("--") ? args.slice(args.indexOf("--") + 1) : paths;
    return Buffer.from(`${selected.join("\0")}\0`);
  },
  async exists(target: string) {
    assert.equal(target, path.join(sourceRoot, ".worktreeinclude"));
    counters.manifest++;
    return true;
  },
  async root(rootReal: string) {
    assert(rootReal === sourceRoot || rootReal === destinationRoot);
    return {
      rootReal,
      async copyIn(
        target: string,
        source: { root: { rootReal: string }; relativePath: string },
        options: {
          preserveSourceMode?: boolean;
          overwrite?: boolean;
          mutationSymlinks?: string;
          assertBeforeMutation?: () => void;
        },
      ) {
        assert.equal(rootReal, destinationRoot);
        assert.equal(source.root.rootReal, sourceRoot);
        assert.equal(options.preserveSourceMode, true);
        assert.equal(options.overwrite, false);
        assert.equal(options.mutationSymlinks, "reject");
        options.assertBeforeMutation?.();
        const relative = path.relative(destinationRoot, target).split(path.sep).join("/");
        assert.equal(source.relativePath, path.join(sourceRoot, relative));
        copied.push(relative);
        counters.copies++;
      },
    };
  },
  dispatch: async (_operation: GitWorktreeOperation): Promise<unknown> => {
    throw new Error("Provisioning runtime was not installed");
  },
};
const key = Symbol.for("openclaw.perf.worktree-provisioning");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const prelude = 'const s=globalThis[Symbol.for("openclaw.perf.worktree-provisioning")];\n';
const modules = new Map<string, string>();
const adapter = (relative: string, source: string) =>
  modules.set(new URL(relative, ownerUrl).href, prelude + source);
const fsUrl = new URL("./synthetic-provisioning-fs.mjs", ownerUrl).href;
modules.set(fsUrl, prelude + "export default s.fs;");
adapter("../../infra/git-worker.ts", "export const runGitWorkerOperation=(op)=>s.dispatch(op);");
adapter(
  "../../infra/fs-safe.ts",
  "export const root=(value)=>s.root(value);export class FsSafeError extends Error {}",
);
adapter(
  "./git.ts",
  "export const requireGitBuffer=(...args)=>s.git(...args);export const worktreePathExists=(value)=>s.exists(value);",
);
for (const [relative, exports] of [
  ["../../infra/file-descriptor.ts", "writeFileWindowFully"],
  ["./registry-read.ts", "getRegistryWorktreeProvisionedChunk"],
  [
    "./capacity.runtime.ts",
    "estimateCheckoutObjectBytes estimateCheckoutTransitionBytes measureDirectoryTreeBytes",
  ],
  [
    "./eviction.runtime.ts",
    "classifyWorktreeEvictions prepareWorktreeEvictionRepositories purgeWorktreeCheckout readWorktreeSourceDependencies",
  ],
  ["./gc-fingerprint.runtime.ts", "readWorktreeCleanupFingerprint"],
] as const) {
  adapter(
    relative,
    exports
      .split(" ")
      .map((name) => `export const ${name}=()=>{throw new Error("Unexpected ${name}")};`)
      .join("\n"),
  );
}
const fsConsumers = new Set([
  ownerUrl,
  new URL("./git-worktree-operations.runtime.ts", ownerUrl).href,
  new URL("./provisioned-file-inspection.ts", ownerUrl).href,
  new URL("../../infra/path-existence.ts", ownerUrl).href,
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "node:fs/promises" && fsConsumers.has(context.parentURL ?? "")
      ? { url: fsUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    const source = modules.get(url);
    return source === undefined
      ? next(url === ownerUrl && baseUrl ? baseUrl : url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
try {
  const { executeGitWorktreeOperation } =
    await import("../../src/agents/worktrees/git-worktree-operations.runtime.js");
  const { provisionIncludedFiles } =
    await import("../../src/agents/worktrees/provisioned-files.js");
  state.dispatch = async (operation) => {
    assert.equal(operation.type, "worktree.provisioning-inspection");
    inspecting = true;
    try {
      return await executeGitWorktreeOperation(operation);
    } finally {
      inspecting = false;
    }
  };
  const operation = async () => {
    copied = [];
    const result = await provisionIncludedFiles(sourceRoot, destinationRoot, {
      assertCurrent: () => {
        counters.authorityChecks++;
      },
    });
    assert.deepEqual(result, paths);
    assert.deepEqual(copied, paths);
  };
  for (let i = 0; i < 20; i++) {
    await operation();
  }
  counters = counts();
  const gc = new GCProfiler();
  gc.start();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedBefore), "Runtime must expose exact V8 allocation counters");
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const durations: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await operation();
    durations.push(performance.now() - start);
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  const collections = gc.stop()?.statistics ?? [];
  const totalGcMs = collections.reduce((sum, entry) => sum + entry.cost / 1000, 0);
  durations.sort((left, right) => left - right);
  assert.equal(counters.copies, iterations * paths.length);
  console.log(
    JSON.stringify({
      arm: baseUrl ? "base" : "candidate",
      ownerSha256: createHash("sha256")
        .update(readFileSync(new URL(baseUrl ?? ownerUrl)))
        .digest("hex"),
      iterations,
      paths: paths.length,
      scope:
        "real provisioning/copy owners with synthetic Git/stat/copy adapters; excludes native I/O, IPC and Gateway latency",
      countsPerOperation: Object.fromEntries(
        Object.entries(counters).map(([name, count]) => [name, count / iterations]),
      ),
      wallMs,
      samples: durations.length,
      p50Ms: durations[Math.ceil(iterations * 0.5) - 1],
      p95Ms: durations[Math.ceil(iterations * 0.95) - 1],
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      allocatedBytesPerOperation: allocatedBytes / iterations,
      totalGcMs,
      gcMsPerOperation: totalGcMs / iterations,
      gcMsPerMinute: (totalGcMs * 60000) / wallMs,
      maxGcPauseMs: collections.reduce((max, entry) => Math.max(max, entry.cost / 1000), 0),
      gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
        const pauses = collections.filter((entry) => entry.gcType === kind);
        return {
          kind,
          count: pauses.length,
          totalMs: pauses.reduce((sum, entry) => sum + entry.cost / 1000, 0),
          maxMs: pauses.reduce((max, entry) => Math.max(max, entry.cost / 1000), 0),
        };
      }),
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      loadBefore,
      loadAfter: loadavg(),
    }),
  );
} finally {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
}
