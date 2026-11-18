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
 * --native-repo <synthetic-checkout> --temporary-root <owned-scratch> exercises
 * native Git against an existing fixture (including partial/APFS clones). It writes
 * refs/openclaw/snapshots/fixture; never point it at a user or production checkout.
 * Git maintenance and lazy fetch are disabled. Commit identity/dates are fixed.
 * Native acceptance: identical snapshot commit, lower median/p95 owner wall and
 * CPU/allocation, no >20% regression; run A/A then five serial interleaved A/B pairs.
 * Phase timings are inclusive; native mode still excludes hydration, IPC, capacity,
 * registry writes and restoration, which require the service removal/restore proof.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    "native-repo": { type: "string" },
    "temporary-root": { type: "string" },
    warmup: { type: "string", default: "5" },
    "child-cpu": { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const warmup = Number(values.warmup);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(!values["child-cpu"] || (values["native-repo"] && process.platform === "darwin"));
const ownerUrl = new URL("../../src/agents/worktrees/snapshot-inventory.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
if (values["base-file"]) {
  assert((await fs.stat(values["base-file"])).isFile());
}
await fs.mkdir(".local", { recursive: true });
const temporary = await fs.mkdtemp(
  path.resolve(values["temporary-root"] ?? ".local", "worktree-snapshot-measure-"),
);
const root = values["native-repo"] ? path.resolve(values["native-repo"]) : temporary;
if (!values["native-repo"]) {
  await fs.mkdir(path.join(root, ".git"));
  for (let bucket = 0; bucket < 60; bucket++) {
    await fs.mkdir(path.join(root, "inventory", String(bucket)), { recursive: true });
  }
}
await fs.mkdir(path.join(temporary, "index"));
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
  "rev-parse ls-tree ls-files config status diff-files cat-file commit-tree update-ref read-tree update-index write-tree".split(
    " ",
  ),
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
const phases: Record<string, number[]> = {};
let childCpuMs = 0;
let inventoryCounts = { tracked: paths.length, untracked: 0 };
const phaseKey = Symbol.for("openclaw.perf.snapshot-phases");
Object.defineProperty(globalThis, phaseKey, {
  configurable: true,
  value: (name: string) => {
    const started = performance.now();
    return () => (phases[name] ??= []).push(performance.now() - started);
  },
});
async function respond(request: unknown): Promise<unknown> {
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
    if (values["native-repo"]) {
      assert(isRecord(input.options));
      const options = input.options;
      assert(options.env === undefined || isRecord(options.env));
      const env = { ...process.env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        assert(value === undefined || typeof value === "string");
        env[key] = value;
      }
      assert(
        options.input === undefined ||
          typeof options.input === "string" ||
          options.input instanceof Uint8Array,
      );
      const started = performance.now();
      const result = await new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>(
        (resolve, reject) => {
          const child = execFile(
            values["child-cpu"] ? "/usr/bin/time" : "git",
            [
              ...(values["child-cpu"] ? ["-lp", "git"] : []),
              "-c",
              "maintenance.auto=false",
              "-c",
              "gc.auto=0",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              ...args,
            ],
            {
              cwd: root,
              encoding: "buffer",
              maxBuffer: 64 * 1024 * 1024,
              env: {
                ...env,
                GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
                GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
                GIT_NO_LAZY_FETCH: "1",
                GIT_NO_REPLACE_OBJECTS: "1",
              },
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolve({ code: 0, stdout, stderr });
              } else if (typeof error.code === "number") {
                resolve({ code: error.code, stdout, stderr });
              } else {
                reject(new Error("Git subprocess did not exit normally", { cause: error }));
              }
            },
          );
          child.stdin?.end(options.input);
        },
      );
      (phases[`git.${command}`] ??= []).push(performance.now() - started);
      if (values["child-cpu"]) {
        const usage = [...result.stderr.toString().matchAll(/^(?:user|sys) ([\d.]+)$/gm)];
        assert.equal(usage.length, 2, "Missing native child CPU counters");
        childCpuMs += usage.reduce((total, match) => total + Number(match[1]) * 1000, 0);
      }
      copiedOutputBytes += result.stdout.byteLength;
      return { ...result, termination: "exit", timeoutMs: 120000 };
    }
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
    return path.join(temporary, "index");
  }
  if (request.type === "worktree.snapshot-inventory") {
    assert(typeof input.tracked === "number" && typeof input.untracked === "number");
    inventoryCounts = { tracked: input.tracked, untracked: input.untracked };
    if (!values["native-repo"]) {
      assert.deepEqual(input, { tracked: paths.length, untracked: 0 });
    }
  } else {
    assert(effects.has(request.type), "unexpected synthetic effect");
  }
  return undefined;
}
const hooks = registerHooks({
  load(url, context, next) {
    if (url === ownerUrl && values["native-repo"]) {
      let source = readFileSync(new URL(baseUrl ?? url), "utf8");
      for (const name of [
        "collectSnapshotInventory",
        "inspectOtherPaths",
        "walkCollapsedPaths",
        "prepareSnapshotIndex",
      ]) {
        source = source.replace(`async function ${name}(`, `async function ${name}Measured(`);
        source += `\nasync function ${name}(...args: Parameters<typeof ${name}Measured>) { const finish = globalThis[Symbol.for("openclaw.perf.snapshot-phases")](${JSON.stringify(name)}); try { return await ${name}Measured(...args); } finally { finish(); } }\n`;
      }
      return { format: "module-typescript", shortCircuit: true, source };
    }
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
            input: await Promise.all(
              value.input.requests.map(async (request: unknown) => ({
                ok: true,
                value: await respond(request),
              })),
            ),
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
  for (let index = 0; index < warmup; index++) {
    await measure();
  }
  commandCounts = {};
  effectCounts = {};
  copiedOutputBytes = 0;
  childCpuMs = 0;
  for (const key of Object.keys(phases)) {
    delete phases[key];
  }
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
      paths: inventoryCounts.tracked,
      scope: values["native-repo"]
        ? "real snapshot owner and native Git; excludes worker IPC, hydration and capacity admission"
        : "real snapshot owner + synthetic trusted Git/effects; excludes native Git, SQLite, fsync and IPC",
      phases,
      ...(values["native-repo"]
        ? {
            snapshotCommit: execFileSync(
              "git",
              ["-C", root, "rev-parse", "refs/openclaw/snapshots/fixture"],
              { encoding: "utf8" },
            ).trim(),
            snapshotMetadata: execFileSync(
              "git",
              ["-C", root, "cat-file", "commit", "refs/openclaw/snapshots/fixture"],
              { encoding: "utf8" },
            ),
            childCpuMs: values["child-cpu"] ? childCpuMs : undefined,
          }
        : {}),
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
  Reflect.deleteProperty(globalThis, phaseKey);
  await fs.rm(temporary, { recursive: true });
}
