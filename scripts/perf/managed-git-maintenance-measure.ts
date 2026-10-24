// Run only on an authorized benchmark host; prepare and measure in separate scopes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "measure" },
    policy: { type: "string", default: "candidate" },
    "state-dir": { type: "string" },
    packs: { type: "string", default: "32" },
    "blobs-per-pack": { type: "string", default: "128" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Synthetic managed Git maintenance, Linux/GNU time required:
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode prepare --state-dir <new-directory>
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode measure --state-dir <prepared-directory>
Prepare creates 32 indexed packs × 128 blobs × 32 KiB (128 MiB), sequentially.
--packs and --blobs-per-pack may reduce the fixture; payload is capped at 128 MiB.
Measure invokes the real hourly maintenance owner, records GNU time's largest-process
RSS and Git trace2 children, then verifies retained objects.
Use --policy baseline or --policy candidate (default) at prepare time to compare
the existing owner with and without the managed project repository policy.
Use a fresh fixture for each run; measurement consumes its fragmented layout.
The caller supplies the quiet-slot lock, swapped CPU placement, production guard,
MemoryMax, and low CPU/IO priority. RSS is not an aggregate process-tree bound.`);
  process.exit(0);
}
assert(values["state-dir"], "--state-dir must name a task-owned synthetic fixture");
assert(["prepare", "measure", "owner"].includes(values.mode), "invalid --mode");
assert(["baseline", "candidate"].includes(values.policy), "invalid --policy");
assert.equal(process.platform, "linux", "This benchmark requires Linux and GNU time");
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "fixture.json");
const trace = path.join(root, "maintenance.trace.jsonl");
const summary = path.join(root, "maintenance.json");
const packCount = Number(values.packs);
const blobsPerPack = Number(values["blobs-per-pack"]);
const blobBytes = 32 * 1024;
const payloadBytes = packCount * blobsPerPack * blobBytes;
assert(Number.isSafeInteger(packCount) && packCount >= 16, "--packs must be an integer >=16");
assert(
  Number.isSafeInteger(blobsPerPack) && blobsPerPack >= 1,
  "--blobs-per-pack must be positive",
);
assert(payloadBytes <= 128 * 1024 * 1024, "Synthetic payload must not exceed 128 MiB");
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
});

async function run(command: string, args: string[], input?: string | Buffer): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      } else {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      }
    });
    child.stdin.end(input);
  });
}
const git = (args: string[], input?: string | Buffer) => run("git", ["-C", repo, ...args], input);
const packs = async () =>
  (await fs.readdir(path.join(repo, ".git", "objects", "pack"))).filter((name) =>
    name.endsWith(".pack"),
  ).length;
async function checkDirty() {
  const meminfo = await fs.readFile("/proc/meminfo", "utf8");
  const dirtyKiB = Number(/^Dirty:\s+(\d+)/m.exec(meminfo)?.[1]);
  assert(Number.isFinite(dirtyKiB) && dirtyKiB < 2 * 1024 * 1024, "Host Dirty exceeds 2 GiB");
}

if (values.mode === "prepare") {
  await checkDirty();
  await fs.mkdir(root); // Refuse existing directories rather than overwrite another fixture.
  for (const directory of [repo, process.env.HOME!, process.env.TMPDIR!]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await git(["init", "--initial-branch=main"]);
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fastimport.unpackLimit", "0"],
  ]) {
    await git(["config", "--local", key!, value!]);
  }
  if (values.policy === "candidate") {
    const { configureProjectCheckoutMaintenance } =
      await import("../../src/projects/project-clone-runtime.js");
    await configureProjectCheckoutMaintenance(repo, { env: process.env });
  }
  const objects: string[] = [];
  let parent: string | undefined;
  for (let index = 0; index < packCount; index++) {
    await checkDirty();
    const commands: Buffer[] = [];
    for (let blob = 0; blob < blobsPerPack; blob++) {
      // Deterministic incompressible data gives paired fixtures identical bytes.
      const nonce = Buffer.alloc(16);
      nonce.writeUInt32LE(index, 0);
      nonce.writeUInt32LE(blob, 4);
      const bytes = createCipheriv("aes-256-ctr", Buffer.alloc(32), nonce).update(
        Buffer.alloc(blobBytes),
      );
      commands.push(
        Buffer.from(`blob\nmark :${blob + 1}\ndata ${blobBytes}\n`),
        bytes,
        Buffer.from("\n"),
      );
    }
    const message = `synthetic pack ${index}`;
    commands.push(
      Buffer.from(
        `commit refs/heads/main\ncommitter Synthetic <synthetic@example.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\n${parent ? `from ${parent}\n` : ""}` +
          Array.from(
            { length: blobsPerPack },
            (_, blob) => `M 100644 :${blob + 1} fixture-${blob}.bin\n`,
          ).join("") +
          "\ndone\n",
      ),
    );
    await git(["fast-import", "--quiet", "--done"], Buffer.concat(commands));
    parent = await git(["rev-parse", "HEAD"]);
    objects.push(...(await git(["ls-tree", "-r", "--format=%(objectname)", "HEAD"])).split("\n"));
  }
  assert.equal(await packs(), packCount);
  const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  try {
    await insertRegistryWorktree(process.env, {
      id: "synthetic-maintenance",
      name: "synthetic-maintenance",
      repoFingerprint: "synthetic-maintenance",
      repoRoot: repo,
      path: repo,
      branch: "main",
      baseRef: "main",
      ownerKind: "manual",
      createdAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_000_000,
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
  const fixture = {
    version: 1,
    policy: values.policy,
    packs: packCount,
    blobBytes,
    payloadBytes,
    objects,
  };
  await fs.writeFile(marker, `${JSON.stringify(fixture)}\n`);
  console.log(JSON.stringify({ mode: "prepare", ...fixture, objects: objects.length }));
} else {
  const fixture: {
    version: number;
    policy: string;
    packs: number;
    blobBytes: number;
    payloadBytes: number;
    objects: string[];
  } = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(fixture.version, 1);
  assert.equal(await packs(), fixture.packs, "Use a fresh prepared fixture for each run");
  if (values.mode === "owner") {
    const { createWorktreeGitMaintenance } =
      await import("../../src/agents/worktrees/git-maintenance.js");
    const { WorktreeGcProgress } = await import("../../src/agents/worktrees/gc-progress.js");
    const { closeOpenClawStateDatabaseAsync } =
      await import("../../src/state/openclaw-state-db.js");
    const progress = new WorktreeGcProgress();
    process.env.GIT_TRACE2_EVENT = trace;
    const started = performance.now();
    try {
      await createWorktreeGitMaintenance(process.env)({ progress });
      assert.equal(progress.result.issueCount, 0, JSON.stringify(progress.result.issues));
      assert.equal(progress.result.gitMaintenance?.stage, "completed");
      await fs.writeFile(summary, JSON.stringify({ elapsedMs: performance.now() - started }));
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
      await closeOpenClawStateDatabaseAsync();
    }
  } else {
    await checkDirty();
    await fs.writeFile(trace, "");
    const timeOutput = path.join(root, "maintenance.time.txt");
    await run("/usr/bin/time", [
      "-v",
      "-o",
      timeOutput,
      process.execPath,
      ...process.execArgv,
      path.resolve(process.argv[1]!),
      "--mode",
      "owner",
      "--state-dir",
      root,
    ]);
    const timing = await fs.readFile(timeOutput, "utf8");
    const peakProcessRssKiB = Number(
      /Maximum resident set size \(kbytes\):\s+(\d+)/.exec(timing)?.[1],
    );
    assert(peakProcessRssKiB > 0, "GNU time did not report peak RSS");
    const childCommands: Record<string, number> = {};
    for (const line of (await fs.readFile(trace, "utf8")).trim().split("\n")) {
      if (!line) {
        continue;
      }
      const event: { event: string; argv?: string[] } = JSON.parse(line);
      if (event.event === "child_start" && event.argv) {
        const command = event.argv.join(" ");
        childCommands[command] = (childCommands[command] ?? 0) + 1;
      }
    }
    const packsAfter = await packs();
    assert(packsAfter < fixture.packs, "The owner did not consolidate the fixture");
    const retained = await git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      `${fixture.objects.join("\n")}\n`,
    );
    assert.equal(retained.split("\n").length, fixture.objects.length);
    for (const [index, line] of retained.split("\n").entries()) {
      assert.equal(line, `${fixture.objects[index]} blob ${fixture.blobBytes}`);
    }
    await git(["fsck", "--full", "--no-dangling"]);
    console.log(
      JSON.stringify(
        {
          ...JSON.parse(await fs.readFile(summary, "utf8")),
          policy: fixture.policy,
          peakProcessRssKiB,
          packsBefore: fixture.packs,
          packsAfter,
          payloadBytes: fixture.payloadBytes,
          verifiedBlobs: fixture.objects.length,
          childCommands,
        },
        null,
        2,
      ),
    );
  }
}
