/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-snapshot-measure.ts --iterations 2000
 * Add --base-file <saved-snapshot-inventory.ts> for the pinned base; alternate arms.
 * Real snapshot owner + worker context, synthetic trusted Git/effect host, 60,001 paths.
 * Measures JS CPU/exact V8 allocation, GC, and command counts. Output buffers are copied.
 * Native Git, SQLite admission, fsync, worker IPC and Gateway latency are excluded;
 * the sessions.delete dev-Gateway run supplies that proof. Tiny fixture directories
 * keep the real fsRoot and nested-marker checks; no actual checkout files are scanned.
 * Acceptance: same inventory/publication, fewer Git/capacity requests, no material
 * CPU/allocation regression. Natural GC only; unforced end heap is context.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    "base-file": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../src/agents/worktrees/snapshot-inventory.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
if (values["base-file"]) {
  assert((await fs.stat(values["base-file"])).isFile());
}
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/worktree-snapshot-measure-"));
await fs.mkdir(path.join(root, ".git"));
await fs.mkdir(path.join(root, "temporary"));
for (let bucket = 0; bucket < 60; bucket++) {
  await fs.mkdir(path.join(root, "inventory", String(bucket)), { recursive: true });
}
const head = "a".repeat(40),
  tree = "b".repeat(40),
  commit = "c".repeat(40);
const paths = Array.from({ length: 60001 }, (_, index) =>
  index === 60000 ? "README.md" : `inventory/${Math.floor(index / 1000)}/${index}.txt`,
);
const blobs = paths.map((_, index) => (index + 1).toString(16).padStart(40, "0"));
const treeOutput = Buffer.from(
  paths.map((file, index) => `100644 blob ${blobs[index]}\t${file}\0`).join(""),
);
const indexOutput = Buffer.from(
  paths.map((file, index) => `H 100644 ${blobs[index]} 0\t${file}\0`).join(""),
);
const commands = new Set(
  "rev-parse ls-tree ls-files config status diff-files cat-file commit-tree update-ref".split(" "),
);
const effects = new Set(
  "worktree.assert-current worktree.snapshot-capacity worktree.snapshot-provisioned-reset".split(
    " ",
  ),
);
const fixedOutput: Record<string, string | Buffer> = {
  "ls-tree": treeOutput,
  "cat-file": Buffer.from(blobs.map((blob) => `${blob} blob\n`).join("")),
  "commit-tree": commit,
};
let commandCounts: Record<string, number> = {},
  effectCounts: Record<string, number> = {};
let copiedOutputBytes = 0;
function respond(request: unknown): unknown {
  assert(isRecord(request) && typeof request.type === "string" && isRecord(request.input));
  const input = request.input;
  if (request.type === "git.text" || request.type === "git.buffer") {
    assert(Array.isArray(input.args));
    const args = input.args.map((arg) => {
      assert(typeof arg === "string");
      return arg;
    });
    const command = args.find((arg) => commands.has(arg));
    assert(command, "unexpected synthetic Git command");
    commandCounts[command] = (commandCounts[command] ?? 0) + 1;
    let output: string | Buffer = fixedOutput[command] ?? "";
    if (command === "rev-parse") {
      output = args.includes("--git-common-dir")
        ? ".git"
        : args.some((arg) => arg.endsWith("^{tree}"))
          ? tree
          : head;
    }
    if (command === "ls-files" && args.includes("--stage")) {
      output = indexOutput;
    }
    if (command === "update-ref") {
      assert(isRecord(input.options) && input.options.input instanceof Uint8Array);
      const publication = Buffer.from(input.options.input).toString();
      assert(publication.includes(`verify HEAD\0${head}\0`));
      assert(publication.includes(`update refs/openclaw/snapshots/fixture\0${commit}\0`));
    }
    const stdout = Buffer.from(output);
    copiedOutputBytes += stdout.byteLength;
    return {
      termination: "exit",
      code: command === "config" ? 1 : 0,
      stdout,
      stderr: Buffer.alloc(0),
      timeoutMs: 120000,
    };
  }
  effectCounts[request.type] = (effectCounts[request.type] ?? 0) + 1;
  if (request.type === "git.temporary-directory") {
    return path.join(root, "temporary");
  }
  if (request.type === "worktree.snapshot-inventory") {
    assert.deepEqual(input, { tracked: paths.length, untracked: 0 });
  } else {
    assert(effects.has(request.type), "unexpected synthetic effect");
  }
  return undefined;
}
const hooks = registerHooks({
  load(url, context, next) {
    return next(url === ownerUrl && baseUrl ? baseUrl : url, context);
  },
});
try {
  const { snapshotWorktree } = await import("../../src/agents/worktrees/snapshot-inventory.ts");
  const { withGitWorkerContext } = await import("../../src/infra/git-worker-context.ts");
  const measure = () =>
    withGitWorkerContext(
      {
        consumeInput() {},
        notify() {},
        async request(value) {
          assert(
            isRecord(value) &&
              value.type === "git.batch" &&
              isRecord(value.input) &&
              Array.isArray(value.input.requests),
          );
          return {
            input: value.input.requests.map((request: unknown) => ({
              ok: true,
              value: respond(request),
            })),
            consumed() {},
          };
        },
      },
      async () => {
        const result = await snapshotWorktree({
          worktreeId: "fixture",
          checkoutPath: root,
          repoRoot: root,
          reason: "synthetic owner measurement",
          provisionedPaths: [],
        });
        assert.deepEqual(result, {
          snapshotRef: "refs/openclaw/snapshots/fixture",
          provisionedState: [],
        });
      },
    );
  for (let warmup = 0; warmup < 5; warmup++) {
    await measure();
  }
  commandCounts = {};
  effectCounts = {};
  copiedOutputBytes = 0;
  const memoryBefore = process.memoryUsage(),
    loadBefore = loadavg();
  const gc = new GCProfiler();
  gc.start();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedBefore), "Runtime must expose exact V8 allocation counters");
  const cpuBefore = process.threadCpuUsage();
  const durations: number[] = [],
    started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const operation = performance.now();
    await measure();
    durations.push(performance.now() - operation);
  }
  const wallMs = performance.now() - started,
    cpu = process.threadCpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  const collections = gc.stop()?.statistics ?? [];
  const totalGcMs = collections.reduce((sum, collection) => sum + collection.cost / 1000, 0);
  durations.sort((left, right) => left - right);
  console.log(
    JSON.stringify({
      revision: baseUrl ? "base" : "candidate",
      iterations,
      paths: paths.length,
      scope:
        "real snapshot owner + synthetic trusted Git/effects; excludes native Git, SQLite, fsync and IPC",
      commandCounts,
      effectCounts,
      copiedOutputBytes,
      wallMs,
      wall: {
        samples: durations.length,
        p50Ms: durations[Math.ceil(iterations * 0.5) - 1],
        p95Ms: durations[Math.ceil(iterations * 0.95) - 1],
      },
      threadCpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      allocatedBytes,
      allocatedBytesPerOperation: allocatedBytes / iterations,
      totalGcMs,
      gcMsPerOperation: totalGcMs / iterations,
      gcMsPerMinute: (totalGcMs * 60000) / wallMs,
      gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
        const pauses = collections
          .filter((entry) => entry.gcType === kind)
          .map((entry) => entry.cost / 1000);
        return {
          kind,
          count: pauses.length,
          totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
          maxMs: pauses.reduce((max, ms) => Math.max(max, ms), 0),
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
  await fs.rm(root, { recursive: true });
}
