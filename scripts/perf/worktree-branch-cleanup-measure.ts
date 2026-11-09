/**
 * Real Git + managed branch cleanup, entirely synthetic and offline.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-branch-cleanup-measure.ts \
 *   --output <new-directory> [--smoke] [--samples 5]
 *
 * Acceptance: remove exactly 615 orphan managed heads, retain all 1,598 linked
 * worktrees and every ordinary ref, and leave zero candidates on the next sweep.
 * Five populated dry-run A/A controls precede five populated/apply/cleaned triples.
 * Setup and verification are untimed. Measurements cover wall, process CPU (all
 * Node threads), main V8 allocation, and native Git CPU. The cleanup is new work;
 * its cost is reported, not presented as a speedup over doing nothing.
 *
 * This owner reads Git metadata and the worktree registry. Empty-tree checkouts
 * intentionally omit unrelated 62k-file payloads and 35-GiB agent transcripts.
 * No filesystem-throughput or publication-fetch latency improvement is claimed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    samples: { type: "string", default: "5" },
    smoke: { type: "boolean", default: false },
  },
});
assert(values.output && global.gc, "--output and --expose-gc are required");
assert(process.platform === "darwin", "Native CPU receipts use macOS time -l");
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const shape = values.smoke
  ? { refs: 80, heads: 30, managed: 18, attachedManaged: 12, linked: 16 }
  : { refs: 13_531, heads: 3_145, managed: 1_843, attachedManaged: 1_228, linked: 1_598 };
const orphanCount = shape.managed - shape.attachedManaged;
const output = path.resolve(values.output);
fs.mkdirSync(output);
for (const directory of ["repo", "home", "state", "tmp", "bin", "git-times"]) {
  fs.mkdirSync(path.join(output, directory));
}
const repoRoot = path.join(output, "repo");
const configPath = path.join(output, "openclaw.json");
const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Synthetic Benchmark",
    GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Benchmark",
    GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
  },
});
fs.writeFileSync(configPath, JSON.stringify({ logging: { consoleLevel: "silent" } }));
const git = (args: string[], input?: string) =>
  execFileSync(actualGit, ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
git(["init", "--quiet", "--template=", "-b", "main"]);
git(["commit", "--quiet", "--allow-empty", "-m", "synthetic ref cleanup fixture"]);
const head = git(["rev-parse", "HEAD"]);
const managed = Array.from({ length: shape.managed }, (_, index) => `openclaw/fixture-${index}`);
const ordinary = Array.from(
  { length: shape.heads - shape.managed - 1 },
  (_, index) => `ordinary/fixture-${index}`,
);
const other = Array.from(
  { length: shape.refs - shape.heads },
  (_, index) => `refs/remotes/origin/fixture-${index}`,
);
const orphanRefs = managed.slice(shape.attachedManaged).map((branch) => `refs/heads/${branch}`);
git(
  ["update-ref", "--stdin"],
  [
    ...managed.map((branch) => `refs/heads/${branch}`),
    ...ordinary.map((branch) => `refs/heads/${branch}`),
    ...other,
  ]
    .map((ref) => `update ${ref} ${head}\n`)
    .join(""),
);
const linkedBranches = [
  ...managed.slice(0, shape.attachedManaged),
  ...ordinary.slice(0, shape.linked - shape.attachedManaged),
];
for (let index = 0; index < linkedBranches.length; index++) {
  git([
    "worktree",
    "add",
    "--quiet",
    "--no-checkout",
    path.join(output, "linked", String(index)),
    linkedBranches[index]!,
  ]);
}
const refs = () => git(["for-each-ref", "--format=%(refname)"]).split("\n");
const initialRefs = refs();
assert.equal(initialRefs.length, shape.refs);
assert.equal(
  git(["worktree", "list", "--porcelain"]).match(/^worktree /gmu)?.length,
  shape.linked + 1,
);
console.log(JSON.stringify({ phase: "prepared", ...shape, orphans: orphanCount }));

const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { resolveRepository } = await import("../../src/agents/worktrees/repository-paths.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const repository = await resolveRepository(repoRoot);
for (let index = 0; index < shape.attachedManaged; index++) {
  await insertRegistryWorktree(process.env, {
    id: `fixture-${index}`,
    name: `fixture-${index}`,
    repoRoot,
    repoFingerprint: repository.fingerprint,
    path: path.join(output, "linked", String(index)),
    branch: managed[index]!,
    baseRef: "main",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 1,
  });
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const timingDirectory = path.join(output, "git-times");
fs.writeFileSync(
  path.join(output, "bin", "git"),
  `#!/bin/sh\nexec /usr/bin/time -l -o ${quote(timingDirectory)}/$$.time ${quote(actualGit)} "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = `${path.join(output, "bin")}:${process.env.PATH}`;
const service = new ManagedWorktreeService({ env: process.env });
type Measurement = {
  label: string;
  wallMs: number;
  processCpuMs: number;
  mainAllocatedBytes: number;
  nativeGitCpuMs: number;
  gitCommands: number;
  refsAfter: number;
  loadBefore: number[];
  loadAfter: number[];
};
const measurements: Measurement[] = [];
async function measure(label: string, dryRun: boolean, expectedRemoved: number) {
  for (const name of fs.readdirSync(timingDirectory)) {
    fs.unlinkSync(path.join(timingDirectory, name));
  }
  global.gc?.();
  const loadBefore = os.loadavg();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const result = await service.pruneOrphanBranches({ repoRoot, dryRun });
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const mainAllocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  assert.equal(result.branches.filter((branch) => branch.outcome === "failed").length, 0);
  assert.equal(
    result.branches.filter((branch) => branch.outcome === "preserved").length,
    shape.attachedManaged,
  );
  assert.equal(
    result.branches.filter((branch) => branch.outcome === (dryRun ? "would-delete" : "deleted"))
      .length,
    label.startsWith("after-") ? 0 : orphanCount,
  );
  const currentRefs = refs();
  assert.equal(currentRefs.length, shape.refs - expectedRemoved);
  assert.deepEqual(
    currentRefs,
    initialRefs.filter((ref) => !expectedRemoved || !orphanRefs.includes(ref)),
  );
  const receipts = fs.readdirSync(timingDirectory);
  let nativeGitCpuMs = 0;
  for (const name of receipts) {
    const receipt = fs.readFileSync(path.join(timingDirectory, name), "utf8");
    const times = receipt.match(/([\d.]+) user\s+([\d.]+) sys/u);
    assert(times);
    nativeGitCpuMs += (Number(times[1]) + Number(times[2])) * 1000;
  }
  const measurement = {
    label,
    wallMs,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    mainAllocatedBytes,
    nativeGitCpuMs,
    gitCommands: receipts.length,
    refsAfter: currentRefs.length,
    loadBefore,
    loadAfter: os.loadavg(),
  };
  measurements.push(measurement);
  fs.writeFileSync(
    path.join(output, `${label}.json`),
    JSON.stringify({ ...measurement, result }, null, 2),
  );
  console.log(JSON.stringify(measurement));
}
try {
  // Warm long-lived state/Git worker startup before A/A controls.
  await service.pruneOrphanBranches({ repoRoot, dryRun: true });
  for (let index = 0; index < 5; index++) {
    await measure(`control-${index}`, true, 0);
  }
  for (let index = 0; index < samples; index++) {
    git(["update-ref", "--stdin"], orphanRefs.map((ref) => `update ${ref} ${head}\n`).join(""));
    await measure(`before-${index}`, true, 0);
    await measure(`cleanup-${index}`, false, orphanCount);
    await measure(`after-${index}`, false, orphanCount);
  }
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        shape,
        orphans: orphanCount,
        node: process.version,
        platform: process.platform,
        registryRecords: shape.attachedManaged,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  await drainGlobalSingletonLifecycleState();
}
