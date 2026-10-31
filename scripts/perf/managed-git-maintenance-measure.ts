// Run only on an authorized benchmark host; prepare and measure in separate scopes.
// Repeated owner proof (Linux or macOS, 48 MiB synthetic payload):
//   node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode prepare --packs 1536 --promisor-packs 1257 --blobs-per-pack 1 --state-dir <new-directory>
//   node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode measure --passes 3 --state-dir <prepared-directory>
// Each pass starts a fresh maintenance owner, retains its production budgets, and
// reports elapsed time and monotonic pack counts. The final check reads every blob.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "measure" },
    policy: { type: "string", default: "candidate" },
    "owner-module": { type: "string" },
    allocations: { type: "boolean" },
    "workspace-files": { type: "string", default: "62000" },
    "state-dir": { type: "string" },
    packs: { type: "string", default: "32" },
    "promisor-packs": { type: "string", default: "0" },
    passes: { type: "string", default: "1" },
    "blobs-per-pack": { type: "string", default: "128" },
    consolidate: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Synthetic managed Git maintenance, Linux/GNU time or macOS/BSD time:
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode prepare --state-dir <new-directory>
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode measure --state-dir <prepared-directory>
Prepare creates 32 indexed packs × 128 blobs × 32 KiB (128 MiB), sequentially.
--packs and --blobs-per-pack may reduce the fixture; payload is capped at 128 MiB.
Measure invokes the real hourly maintenance owner, records time's largest-process
RSS and Git trace2 children, then verifies every retained fixture blob.
--passes N (default 1) creates a fresh owner for each consecutive pass and reports
each pass's elapsed time and pack counts, asserting that pack counts never increase.
For repeated bounded convergence use --packs 1536 --blobs-per-pack 1 at prepare
time and --passes 3 at measure time (48 MiB payload).
Add --promisor-packs 1257 at prepare time for mixed promisor/ordinary pack groups;
markers are added only after generation, to the first N packs in filename order.
Use --policy baseline or --policy candidate (default) at prepare time to compare
the existing owner with and without the managed project repository policy.
Use a fresh fixture for each run; measurement consumes its fragmented layout.
Index-heavy backlog (three overlapping promisor packs, remaining singleton packs):
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode prepare-backlog --packs 1500 --blobs-per-pack 700000 --state-dir <new-directory>
  node --import ./scripts/tsx.mjs scripts/perf/managed-git-maintenance-measure.ts --mode measure-backlog --passes 3 --state-dir <prepared-directory>
Each large index is about 19.6 MB; a pair exceeds the former 32 MiB batch limit.
The fixture shares deterministic 16-byte blobs and adds a unique blob per pack.
Reads include warmup plus five A/A pairs before and after real owner maintenance;
owner time reports process-tree CPU/RSS. Add --allocations for a separate sampled
JavaScript allocation pass; leave it off for timing. Retention checks every shared
and unique added blob, then runs full fsck. The checkout has 62000 tracked 18KiB files
(1.14GB), with one dirty file; --workspace-files may reduce this for a smoke test.
--mode augment-backlog adds this workspace to an older unaugmented backlog fixture.
The workspace adds one pack to the requested fragmented pack count.
Optional --owner-module <path> selects a frozen owner module for baseline proof;
its imports must resolve to the original dependencies. Use a fresh fixture for each arm.
Dependency-free native Git MIDX probe (Linux/GNU time or macOS/BSD time):
  node scripts/perf/managed-git-maintenance-measure.ts --mode prepare-midx --packs 32 --blobs-per-pack 65536 --state-dir <new-directory>
  node scripts/perf/managed-git-maintenance-measure.ts --mode measure-midx --state-dir <prepared-directory>
This fixture contains 2,097,152 unique 16-byte blobs (32 MiB payload), written in
sequential packs. The probe times the old full MIDX write and repeated cat-file
lookups with/without that optional cache; it does not invoke the maintenance owner.
Add --consolidate to perform one native equivalent of its geometric batch before
the probe, capped at 512 MiB of packs / 32 MiB of indexes. At least two packs must
fit, with their total size at least twice the largest. This consumes fragmentation.
The caller supplies the quiet-slot lock, swapped CPU placement, production guard,
MemoryMax, and low CPU/IO priority. RSS is not an aggregate process-tree bound.`);
  process.exit(0);
}
assert(values["state-dir"], "--state-dir must name a task-owned synthetic fixture");
assert(
  [
    "prepare",
    "measure",
    "owner",
    "prepare-midx",
    "measure-midx",
    "prepare-backlog",
    "augment-backlog",
    "measure-backlog",
    "owner-backlog",
  ].includes(values.mode),
  "invalid --mode",
);
assert(["baseline", "candidate"].includes(values.policy), "invalid --policy");
const nativeMidx = values.mode.endsWith("-midx");
const backlog = values.mode.endsWith("-backlog");
assert(
  process.platform === "linux" || process.platform === "darwin",
  "The benchmark requires Linux or macOS",
);
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "fixture.json");
const trace = path.join(root, "maintenance.trace.jsonl");
const summary = path.join(root, "maintenance.json");
const packCount = Number(values.packs);
const promisorPackCount = Number(values["promisor-packs"]);
const passCount = Number(values.passes);
const blobsPerPack = Number(values["blobs-per-pack"]);
const blobBytes = nativeMidx || backlog ? 16 : 32 * 1024;
const payloadBytes = (backlog ? blobsPerPack + packCount : packCount * blobsPerPack) * blobBytes;
assert(Number.isSafeInteger(packCount) && packCount >= 16, "--packs must be an integer >=16");
assert(
  Number.isSafeInteger(promisorPackCount) &&
    promisorPackCount >= 0 &&
    promisorPackCount <= packCount,
  "--promisor-packs must be an integer between 0 and --packs",
);
assert(!nativeMidx || promisorPackCount === 0, "Promisor packs require the owner benchmark");
assert(Number.isSafeInteger(passCount) && passCount >= 1, "--passes must be a positive integer");
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
const promisorPacks = async () =>
  (await fs.readdir(path.join(repo, ".git", "objects", "pack"))).filter((name) =>
    name.endsWith(".promisor"),
  ).length;
async function checkDirty() {
  if (process.platform !== "linux") {
    return;
  }
  const meminfo = await fs.readFile("/proc/meminfo", "utf8");
  const dirtyKiB = Number(/^Dirty:\s+(\d+)/m.exec(meminfo)?.[1]);
  assert(Number.isFinite(dirtyKiB) && dirtyKiB < 2 * 1024 * 1024, "Host Dirty exceeds 2 GiB");
}

if (values.mode === "prepare-backlog") {
  await prepareBacklog();
} else if (values.mode === "prepare" || values.mode === "prepare-midx") {
  await checkDirty();
  await fs.mkdir(root); // Refuse existing directories rather than overwrite another fixture.
  for (const directory of [repo, process.env.HOME!, process.env.TMPDIR!]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await git(["init", "--initial-branch=main", ...(nativeMidx ? ["--object-format=sha1"] : [])]);
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fastimport.unpackLimit", "0"],
  ]) {
    await git(["config", "--local", key!, value!]);
  }
  if (!nativeMidx && values.policy === "candidate") {
    const { configureProjectCheckoutMaintenance } =
      await import("../../src/projects/project-clone-runtime.js");
    await configureProjectCheckoutMaintenance(repo, { env: process.env });
  }
  const objects: string[] = [];
  const sampleStride = Math.max(1, Math.floor((packCount * blobsPerPack) / 4096));
  let parent: string | undefined;
  for (let index = 0; index < packCount; index++) {
    await checkDirty();
    const commands: Buffer[] = [];
    for (let blob = 0; blob < blobsPerPack; blob++) {
      // Deterministic incompressible data gives paired fixtures identical bytes.
      const nonce = Buffer.alloc(16);
      nonce.writeUInt32LE(index, 0);
      nonce.writeUInt32LE(blob, 4);
      const bytes = nativeMidx
        ? nonce
        : createCipheriv("aes-256-ctr", Buffer.alloc(32), nonce).update(Buffer.alloc(blobBytes));
      commands.push(
        Buffer.from(`blob\n${nativeMidx ? "" : `mark :${blob + 1}\n`}data ${blobBytes}\n`),
        bytes,
        Buffer.from("\n"),
      );
      if (nativeMidx && (index * blobsPerPack + blob) % sampleStride === 0) {
        objects.push(createHash("sha1").update(`blob ${blobBytes}\0`).update(bytes).digest("hex"));
      }
    }
    if (nativeMidx) {
      commands.push(Buffer.from("done\n"));
      await git(["fast-import", "--quiet", "--done"], Buffer.concat(commands));
      continue;
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
  if (promisorPackCount > 0) {
    const directory = path.join(repo, ".git", "objects", "pack");
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".pack")).toSorted();
    for (const name of names.slice(0, promisorPackCount)) {
      await fs.writeFile(path.join(directory, name.replace(/\.pack$/, ".promisor")), "");
    }
  }
  if (nativeMidx) {
    const inventory = await git(["count-objects", "-v"]);
    assert.equal(Number(/^in-pack: (\d+)$/m.exec(inventory)?.[1]), packCount * blobsPerPack);
  }
  if (!nativeMidx) {
    const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
    const { closeOpenClawStateDatabaseAsync } =
      await import("../../src/state/openclaw-state-db.js");
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
  }
  const fixture = {
    version: 1,
    policy: values.policy,
    packs: packCount,
    promisorPacks: promisorPackCount,
    blobBytes,
    payloadBytes,
    ...(nativeMidx ? { nativeMidx: true, objectCount: packCount * blobsPerPack } : {}),
    objects,
  };
  await fs.writeFile(marker, `${JSON.stringify(fixture)}\n`);
  console.log(JSON.stringify({ mode: values.mode, ...fixture, objects: objects.length }));
} else {
  const fixture: {
    version: number;
    policy: string;
    packs: number;
    promisorPacks?: number;
    blobBytes: number;
    payloadBytes: number;
    objects: string[];
    nativeMidx?: boolean;
    objectCount?: number;
    sharedObjects?: number;
  } = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(fixture.version, 1);
  if (!nativeMidx) {
    assert.equal(await packs(), fixture.packs, "Use a fresh prepared fixture for each run");
    assert.equal(
      await promisorPacks(),
      fixture.promisorPacks ?? 0,
      "Fixture promisor count changed",
    );
  }
  if (values.mode === "augment-backlog") {
    console.log(JSON.stringify(await augmentBacklogWorkspace()));
  } else if (values.mode === "measure-midx") {
    assert(fixture.nativeMidx, "Use a prepare-midx fixture");
    await checkDirty();
    const packDirectory = path.join(repo, ".git", "objects", "pack");
    const indexPath = path.join(packDirectory, "multi-pack-index");
    let consolidation: { packsBefore: number; packsAfter: number; selected: number } | undefined;
    await fs.rm(indexPath, { force: true });
    if (values.consolidate) {
      const inventory = [];
      for (const name of await fs.readdir(packDirectory)) {
        if (name.endsWith(".pack")) {
          inventory.push({
            name,
            bytes: (await fs.stat(path.join(packDirectory, name))).size,
            indexBytes: (await fs.stat(path.join(packDirectory, name.replace(/\.pack$/, ".idx"))))
              .size,
          });
        }
      }
      const selected: Array<{ name: string; bytes: number }> = [];
      let bytes = 0;
      let indexBytes = 0;
      for (const pack of inventory.toSorted(
        (a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name),
      )) {
        if (pack.indexBytes > 32 * 1024 * 1024) {
          continue;
        }
        if (
          bytes + pack.bytes > 512 * 1024 * 1024 ||
          indexBytes + pack.indexBytes > 32 * 1024 * 1024 ||
          selected.length >= 1024
        ) {
          break;
        }
        selected.push(pack);
        bytes += pack.bytes;
        indexBytes += pack.indexBytes;
      }
      while (selected.length > 1 && bytes < 2 * selected.at(-1)!.bytes) {
        bytes -= selected.pop()!.bytes;
      }
      if (selected.length >= 2) {
        const selectedNames = selected.map((pack) => pack.name);
        await run("git", [
          "-C",
          packDirectory,
          "-c",
          "pack.threads=1",
          "verify-pack",
          "--object-format=sha1",
          ...selectedNames,
        ]);
        const published = await git(
          [
            "-c",
            "alias.fixture-consolidate=!git pack-objects --stdin-packs --stdout --window=0 --threads=1 | git index-pack --stdin --threads=1",
            "fixture-consolidate",
          ],
          `${selectedNames.join("\n")}\n`,
        );
        const hash = /^pack\s+([a-f0-9]{40})$/.exec(published)?.[1];
        assert(hash, "Native consolidation did not publish a pack identity");
        for (const name of selectedNames) {
          if (name === `pack-${hash}.pack`) {
            continue;
          }
          for (const extension of ["idx", "pack", "rev"]) {
            await fs.rm(path.join(packDirectory, name.replace(/\.pack$/, `.${extension}`)), {
              force: true,
            });
          }
        }
      }
      consolidation = {
        packsBefore: inventory.length,
        packsAfter: await packs(),
        selected: selected.length >= 2 ? selected.length : 0,
      };
    }
    const indexNames = (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx"));
    const timingPath = path.join(root, "midx.time.txt");
    const started = performance.now();
    await run(
      "/usr/bin/time",
      [
        ...(process.platform === "darwin" ? ["-l", "-p"] : ["-v"]),
        "-o",
        timingPath,
        "git",
        "-C",
        repo,
        "multi-pack-index",
        "write",
        "--stdin-packs",
      ],
      `${indexNames.join("\n")}\n`,
    );
    const elapsedMs = performance.now() - started;
    const timing = await fs.readFile(timingPath, "utf8");
    const peakProcessRssKiB =
      process.platform === "darwin"
        ? Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1]) / 1024
        : Number(/Maximum resident set size \(kbytes\):\s+(\d+)/.exec(timing)?.[1]);
    assert(peakProcessRssKiB > 0, "time did not report peak RSS");
    const savedIndexPath = path.join(root, "saved-multi-pack-index");
    const lookups: Array<{ midx: boolean; elapsedMs: number; objects: number }> = [];
    // Mix packs deterministically rather than giving ordinary indexes pack-local reads.
    const lookupObjects = fixture.objects
      .map((oid) => ({ oid, order: createHash("sha256").update(oid).digest("hex") }))
      .toSorted((a, b) => a.order.localeCompare(b.order))
      .map(({ oid }) => oid);
    const input = `${lookupObjects.join("\n")}\n`;
    // Both modes are warmed before the fixed ABBA order; every response is checked.
    const lookup = async (midx: boolean) => {
      const start = performance.now();
      const output = await git(
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        input,
      );
      const duration = performance.now() - start;
      assert.equal(
        output,
        lookupObjects.map((oid) => `${oid} blob ${fixture.blobBytes}`).join("\n"),
      );
      return { midx, elapsedMs: duration, objects: fixture.objects.length };
    };
    await lookup(true);
    await fs.rename(indexPath, savedIndexPath);
    await lookup(false);
    let hasIndex = false;
    for (const midx of [true, false, false, true, true, false, false, true]) {
      if (midx !== hasIndex) {
        await fs.rename(midx ? savedIndexPath : indexPath, midx ? indexPath : savedIndexPath);
        hasIndex = midx;
      }
      lookups.push(await lookup(midx));
    }
    console.log(
      JSON.stringify(
        {
          mode: values.mode,
          platform: process.platform,
          gitVersion: await run("git", ["--version"]),
          objectCount: fixture.objectCount,
          packs: await packs(),
          consolidation,
          payloadBytes: fixture.payloadBytes,
          elapsedMs,
          peakProcessRssKiB,
          userSeconds: Number(
            (process.platform === "darwin"
              ? /^user\s+([\d.]+)/m
              : /User time \(seconds\):\s+([\d.]+)/
            ).exec(timing)?.[1],
          ),
          systemSeconds: Number(
            (process.platform === "darwin"
              ? /^sys\s+([\d.]+)/m
              : /System time \(seconds\):\s+([\d.]+)/
            ).exec(timing)?.[1],
          ),
          midxBytes: (await fs.stat(indexPath)).size,
          lookups,
        },
        null,
        2,
      ),
    );
  } else if (values.mode === "owner" || values.mode === "owner-backlog") {
    const { createWorktreeGitMaintenance } = await import(
      values["owner-module"]
        ? pathToFileURL(path.resolve(values["owner-module"])).href
        : "../../src/agents/worktrees/git-maintenance.js"
    );
    const { WorktreeGcProgress } = await import("../../src/agents/worktrees/gc-progress.js");
    const { closeOpenClawStateDatabaseAsync } =
      await import("../../src/state/openclaw-state-db.js");
    process.env.GIT_TRACE2_EVENT = trace;
    const inspector = values.allocations ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const passes = [];
    try {
      for (let pass = 1; pass <= passCount; pass++) {
        await checkDirty();
        const packsBefore = await packs();
        const promisorPacksBefore = await promisorPacks();
        const progress = new WorktreeGcProgress();
        const passStarted = performance.now();
        await createWorktreeGitMaintenance(process.env)({ progress });
        const elapsedMs = performance.now() - passStarted;
        assert.equal(progress.result.issueCount, 0, JSON.stringify(progress.result.issues));
        assert.equal(progress.result.gitMaintenance?.stage, "completed");
        const packsAfter = await packs();
        const promisorPacksAfter = await promisorPacks();
        assert(packsAfter <= packsBefore, `Pass ${pass} increased the synthetic pack count`);
        assert(promisorPacksAfter <= promisorPacksBefore, `Pass ${pass} increased promisor packs`);
        passes.push({
          pass,
          elapsedMs,
          hostLoad: loadavg(),
          packsBefore,
          packsAfter,
          promisorPacksBefore,
          promisorPacksAfter,
        });
        await fs.writeFile(
          summary,
          JSON.stringify({ elapsedMs: performance.now() - started, passes }),
        );
      }
    } finally {
      let sampledAllocationBytes: number | undefined;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        inspector.disconnect();
        const allocated = (node: typeof profile.head): number =>
          node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
        sampledAllocationBytes = allocated(profile.head);
      }
      await fs.writeFile(
        summary,
        JSON.stringify({
          elapsedMs: performance.now() - started,
          cpu: process.cpuUsage(cpuStarted),
          sampledAllocationBytes,
          passes,
        }),
      );
      delete process.env.GIT_TRACE2_EVENT;
      await closeOpenClawStateDatabaseAsync();
    }
  } else {
    await checkDirty();
    await fs.writeFile(trace, "");
    const beforeReads = backlog ? await measureReads("before", fixture.objects) : undefined;
    const timeOutput = path.join(root, "maintenance.time.txt");
    await run("/usr/bin/time", [
      ...(process.platform === "darwin" ? ["-l", "-p"] : ["-v"]),
      "-o",
      timeOutput,
      process.execPath,
      ...process.execArgv,
      path.resolve(process.argv[1]!),
      "--mode",
      backlog ? "owner-backlog" : "owner",
      ...(values.allocations ? ["--allocations"] : []),
      ...(values["owner-module"] ? ["--owner-module", path.resolve(values["owner-module"])] : []),
      "--state-dir",
      root,
      "--passes",
      String(passCount),
    ]);
    const timing = await fs.readFile(timeOutput, "utf8");
    const peakProcessRssKiB =
      process.platform === "darwin"
        ? Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1]) / 1024
        : Number(/Maximum resident set size \(kbytes\):\s+(\d+)/.exec(timing)?.[1]);
    assert(peakProcessRssKiB > 0, "time did not report peak RSS");
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
    const afterReads = backlog ? await measureReads("after", fixture.objects) : undefined;
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
    if (backlog) {
      assert(fixture.sharedObjects !== undefined);
      const shared = Array.from({ length: fixture.sharedObjects }, (_, index) => {
        const bytes = Buffer.alloc(16);
        bytes.writeUInt32LE(index);
        return createHash("sha1").update("blob 16\0").update(bytes).digest("hex");
      });
      const checked = await git(
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        `${shared.join("\n")}\n`,
      );
      assert.equal(checked, shared.map((oid) => `${oid} blob 16`).join("\n"));
    }
    await git(["fsck", "--full", "--no-dangling"]);
    console.log(
      JSON.stringify(
        {
          ...JSON.parse(await fs.readFile(summary, "utf8")),
          platform: process.platform,
          hostLoad: loadavg(),
          policy: fixture.policy,
          gitVersion: await run("git", ["--version"]),
          resource: parseTiming(timing),
          beforeReads,
          afterReads,
          peakProcessRssKiB,
          packsBefore: fixture.packs,
          packsAfter,
          promisorPacksBefore: fixture.promisorPacks ?? 0,
          promisorPacksAfter: await promisorPacks(),
          payloadBytes: fixture.payloadBytes,
          verifiedBlobs: fixture.objects.length,
          verifiedSharedBlobs: fixture.sharedObjects,
          childCommands,
        },
        null,
        2,
      ),
    );
  }
}

function parseTiming(timing: string) {
  return {
    userSeconds: Number(
      (process.platform === "darwin"
        ? /^user\s+([\d.]+)/m
        : /User time \(seconds\):\s+([\d.]+)/
      ).exec(timing)?.[1],
    ),
    systemSeconds: Number(
      (process.platform === "darwin"
        ? /^sys\s+([\d.]+)/m
        : /System time \(seconds\):\s+([\d.]+)/
      ).exec(timing)?.[1],
    ),
    peakProcessRssKiB:
      process.platform === "darwin"
        ? Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1]) / 1024
        : Number(/Maximum resident set size \(kbytes\):\s+(\d+)/.exec(timing)?.[1]),
  };
}

async function measureReads(phase: string, objects: string[]) {
  const lookups = objects.toSorted((a, b) =>
    createHash("sha256")
      .update(a)
      .digest("hex")
      .localeCompare(createHash("sha256").update(b).digest("hex")),
  );
  const operations = [
    { name: "status", args: ["status", "--porcelain", "--untracked-files=no"] },
    { name: "diff-stat", args: ["diff", "--stat", "HEAD"] },
    { name: "rev-parse", args: ["rev-parse", "HEAD"] },
    {
      name: "cat-file",
      args: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      input: `${lookups.join("\n")}\n`,
    },
  ];
  const samples = [];
  for (const operation of operations) {
    const expected = await git(operation.args, operation.input);
    if (operation.name === "cat-file") {
      assert.equal(expected, lookups.map((oid) => `${oid} blob 16`).join("\n"));
    }
    for (let pair = 0; pair < 5; pair++) {
      for (const control of ["A", "A2"]) {
        const timingPath = path.join(root, "read.time.txt");
        const started = performance.now();
        const result = await run(
          "/usr/bin/time",
          [
            ...(process.platform === "darwin" ? ["-l", "-p"] : ["-v"]),
            "-o",
            timingPath,
            "git",
            "-C",
            repo,
            ...operation.args,
          ],
          operation.input,
        );
        const elapsedMs = performance.now() - started;
        assert.equal(result, expected);
        samples.push({
          phase,
          operation: operation.name,
          pair,
          control,
          elapsedMs,
          ...parseTiming(await fs.readFile(timingPath, "utf8")),
        });
      }
    }
  }
  return samples;
}

async function prepareBacklog() {
  await checkDirty();
  await fs.mkdir(root);
  for (const directory of [repo, process.env.HOME!, process.env.TMPDIR!]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await git(["init", "--initial-branch=main", "--object-format=sha1"]);
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fastimport.unpackLimit", "0"],
    ["pack.threads", "1"],
  ]) {
    await git(["config", "--local", key!, value!]);
  }
  const directory = path.join(repo, ".git", "objects", "pack");
  const shared: string[] = [];
  const commands: Buffer[] = [];
  for (let index = 0; index < blobsPerPack; index++) {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32LE(index);
    shared.push(createHash("sha1").update("blob 16\0").update(bytes).digest("hex"));
    commands.push(Buffer.from("blob\ndata 16\n"), bytes, Buffer.from("\n"));
  }
  commands.push(Buffer.from("done\n"));
  await git(["fast-import", "--quiet", "--done"], Buffer.concat(commands));
  commands.length = 0;
  const seedPacks = await fs.readdir(directory);
  const objects = shared.filter(
    (_, index) => index % Math.max(1, Math.floor(blobsPerPack / 4096)) === 0,
  );
  for (let index = 0; index < 3; index++) {
    const bytes = Buffer.alloc(16, index + 1);
    const oid = await git(["hash-object", "-w", "--stdin"], bytes);
    objects.push(oid);
    const hash = await git(
      ["pack-objects", "--window=0", "--threads=1", path.join(directory, "pack")],
      `${shared.join("\n")}\n${oid}\n`,
    );
    await fs.writeFile(path.join(directory, `pack-${hash}.promisor`), "");
  }
  for (const name of seedPacks) {
    await fs.rm(path.join(directory, name));
  }
  for (let index = 3; index < packCount; index++) {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32LE(index);
    bytes.writeUInt32LE(1, 4);
    const oid = createHash("sha1").update("blob 16\0").update(bytes).digest("hex");
    objects.push(oid);
    const suffix =
      index === packCount - 1
        ? "commit refs/heads/main\ncommitter Synthetic <synthetic@example.invalid> 1700000000 +0000\ndata 7\nfixture\nM 100644 :1 fixture.bin\n\ndone\n"
        : "done\n";
    await git(
      ["fast-import", "--quiet", "--done"],
      Buffer.concat([Buffer.from("blob\nmark :1\ndata 16\n"), bytes, Buffer.from(`\n${suffix}`)]),
    );
  }
  await git(["prune-packed"]);
  await git(["checkout", "--force", "main"]);
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
      createdAt: 1700000000000,
      lastActiveAt: 1700000000000,
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
  const fixture = {
    version: 1,
    policy: values.policy,
    packs: packCount,
    promisorPacks: 3,
    blobBytes: 16,
    payloadBytes,
    objects,
    backlog: true,
    sharedObjects: blobsPerPack,
  };
  await fs.writeFile(marker, `${JSON.stringify(fixture)}\n`);
  await augmentBacklogWorkspace();
  const complete: typeof fixture = JSON.parse(await fs.readFile(marker, "utf8"));
  const inventory = [];
  for (const name of (await fs.readdir(directory)).filter((entry) => entry.endsWith(".pack"))) {
    inventory.push({
      name,
      bytes: (await fs.stat(path.join(directory, name))).size,
      indexBytes: (await fs.stat(path.join(directory, name.replace(/\.pack$/, ".idx")))).size,
    });
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      ...complete,
      objects: objects.length,
      largest: inventory.toSorted((a, b) => b.indexBytes - a.indexBytes).slice(0, 3),
      totalPackBytes: inventory.reduce((sum, pack) => sum + pack.bytes, 0),
      totalIndexBytes: inventory.reduce((sum, pack) => sum + pack.indexBytes, 0),
    }),
  );
}

async function augmentBacklogWorkspace() {
  const fixture: {
    packs: number;
    objects: string[];
    workspaceFiles?: number;
    workspaceBytes?: number;
  } = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(fixture.workspaceFiles, undefined, "Workspace already prepared");
  const count = Number(values["workspace-files"]);
  assert(
    Number.isSafeInteger(count) && count > 0 && count <= 62000,
    "--workspace-files must be 1..62000",
  );
  const bytes = Buffer.alloc(18 * 1024, "synthetic workspace line\n");
  bytes[bytes.length - 1] = 10;
  const parent = await git(["rev-parse", "HEAD"]);
  const filePath = (index: number) =>
    `workspace/${String(Math.floor(index / 1000)).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.txt`;
  const changes = Array.from(
    { length: count },
    (_, index) => `M 100644 :1 ${filePath(index)}\n`,
  ).join("");
  await git(
    ["fast-import", "--quiet", "--done"],
    Buffer.concat([
      Buffer.from(`blob\nmark :1\ndata ${bytes.length}\n`),
      bytes,
      Buffer.from(
        `\ncommit refs/heads/main\ncommitter Synthetic <synthetic@example.invalid> 1700000001 +0000\ndata 9\nworkspace\nfrom ${parent}\ndeleteall\n${changes}\ndone\n`,
      ),
    ]),
  );
  await git(["checkout", "--force", "main"]);
  await fs.appendFile(path.join(repo, filePath(0)), "changed\n");
  fixture.packs = await packs();
  fixture.workspaceFiles = count;
  fixture.workspaceBytes = count * bytes.length + 8;
  await fs.writeFile(marker, `${JSON.stringify(fixture)}\n`);
  return {
    mode: "workspace",
    packs: fixture.packs,
    workspaceFiles: count,
    workspaceBytes: fixture.workspaceBytes,
  };
}
