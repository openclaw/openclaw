// Run: node --import ./scripts/tsx.mjs scripts/perf/worktree-branches-measure.ts
// --base-file <saved-branches.runtime.ts> selects a pinned owner in the current graph.
// --iterations 2000 (default), --allocation for a separate sampled-allocation pass,
// --cold to refresh on every call (default 10 iterations). Alternate baseline and
// candidate runs. Acceptance: identical response bytes, one metadata walk instead
// of two for status requests, lower warm CPU/allocation, unchanged Git command count.
// Creates a synthetic Git repository with 10k indexed files, 1,200 local + 1,200
// remote refs and three linked worktrees. Calls the real owner with native Git
// through its worker channel; excludes transport/queue cost and Git child CPU.
// Warm samples use a nested linked checkout; cold samples alternate checkouts.
// Fixture setup and initial inventories are excluded. No operator state is read.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    iterations: { type: "string" },
    allocation: { type: "boolean" },
    cold: { type: "boolean" },
  },
});
const iterations = Number(values.iterations ?? (values.cold ? "10" : "2000"));
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = await fs.mkdtemp(path.join(tmpdir(), "worktree-branches-measure-"));
const repo = path.join(root, "repo");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(root, "config"),
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const gitArgs = [
  "-c",
  "core.hooksPath=" + path.join(root, "no-hooks"),
  "-c",
  "core.fsmonitor=false",
];
const git = (args: string[], input?: string) =>
  execFileSync("git", [...gitArgs, ...args], {
    cwd: repo,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const nativeGit = promisify(execFile);
const inspector = new Session();
const ownerUrl = new URL("../../src/agents/worktrees/branches.runtime.ts", import.meta.url).href;
const baseUrl = values["base-file"]
  ? pathToFileURL(path.resolve(values["base-file"])).href
  : undefined;
const hooks = registerHooks({
  load(url, context, next) {
    return next(url === ownerUrl && baseUrl ? baseUrl : url, context);
  },
});
try {
  await fs.mkdir(repo);
  git(["init", "-b", "main"]);
  const blob = git(["hash-object", "-w", "--stdin"], "synthetic file\n");
  git(
    ["update-index", "--index-info"],
    Array.from({ length: 10000 }, (_, i) => `100644 ${blob}\tfiles/${i}.txt\n`).join(""),
  );
  const commit = git(["commit-tree", git(["write-tree"]), "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", commit]);
  git(
    ["update-ref", "--stdin"],
    Array.from(
      { length: 1200 },
      (_, i) =>
        `update refs/heads/branch-${String(i).padStart(4, "0")} ${commit}\nupdate refs/remotes/origin/branch-${String(i).padStart(4, "0")} ${commit}\n`,
    ).join(""),
  );
  git(["update-ref", "refs/remotes/origin/main", commit]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["pack-refs", "--all"]);
  const checkouts = [repo];
  for (let i = 0; i < 3; i++) {
    const checkout = path.join(root, `linked-${i}`);
    git(["worktree", "add", "--no-checkout", "-b", `selected-${i}`, checkout, "HEAD"]);
    const nested = path.join(checkout, "packages", "app", "src");
    await fs.mkdir(nested, { recursive: true });
    checkouts.push(nested);
  }
  const { readRepositoryBranches } = await import("../../src/agents/worktrees/branches.runtime.ts");
  const { withGitWorkerContext } = await import("../../src/infra/git-worker-context.ts");
  let commands: Record<string, number> = {};
  const expected: string[] = [];
  const measure = async (index: number) => {
    const checkout = values.cold ? index % checkouts.length : 1;
    const result = await withGitWorkerContext(
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
          const replies = [];
          for (const request of value.input.requests) {
            assert(isRecord(request) && request.type === "git.text" && isRecord(request.input));
            const { cwd, args } = request.input;
            assert(
              typeof cwd === "string" &&
                Array.isArray(args) &&
                args.every((arg) => typeof arg === "string"),
            );
            const command = args.includes("for-each-ref") ? "for-each-ref" : args[0];
            assert(command, "Git command must be nonempty");
            commands[command] = (commands[command] ?? 0) + 1;
            const { stdout, stderr } = await nativeGit("git", [...gitArgs, ...args], {
              cwd,
              env,
              encoding: "buffer",
              maxBuffer: 256 * 1024,
            });
            replies.push({ ok: true, value: { code: 0, termination: "exit", stdout, stderr } });
          }
          return { input: replies, consumed() {} };
        },
      },
      () => readRepositoryBranches(checkouts[checkout]!, { includeRepositoryStatus: true }),
      values.cold ? `refresh-${index}` : "fixture",
    );
    const bytes = JSON.stringify(result);
    if (expected[checkout] === undefined) {
      expected[checkout] = bytes;
    } else {
      assert.equal(bytes, expected[checkout]);
    }
  };
  for (let i = 0; i < 8; i++) {
    await measure(i);
  }
  commands = {};
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [],
    loadBefore = loadavg(),
    cpuStart = process.cpuUsage(),
    start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const begin = performance.now();
    await measure(i);
    samples.push(performance.now() - begin);
  }
  const wallMs = performance.now() - start,
    cpu = process.cpuUsage(cpuStart);
  let allocationBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocationBytes = sum(profile.head) / iterations;
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      arm: baseUrl ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      cold: Boolean(values.cold),
      iterations,
      commands,
      responseSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      wallMs,
      cpuUsPerCall: (cpu.user + cpu.system) / iterations,
      allocationBytesPerCall: allocationBytes,
      p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
      p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  hooks.deregister();
  await fs.rm(root, { recursive: true, force: true });
}
