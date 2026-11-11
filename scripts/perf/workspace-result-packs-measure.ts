/**
 * Synthetic result staging/materialization/settlement through the production owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-result-packs-measure.ts prepare <scratch> [files=62000] [bytes=18000] [changed=300]
 * [OPENCLAW_BENCH_BASELINE_DIR=<frozen sparse source>] node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-result-packs-measure.ts run <scratch> <label> [results=6] [timing|allocation|cpu]
 *
 * Run two same-source A/A pairs, then five serial interleaved A/B pairs. Each arm
 * starts with a fresh blob:none file:// clone and a linked worktree containing
 * 62k actual files (1.116 GB) and 1,500 pre-existing packs. The seed shares identical baseline blobs; each
 * result adds 300 distinct 18k-byte blobs across 43 directories. Setup and fixture
 * rewrites are outside the measured owner window. Result 0 is cold owner state;
 * later results are warm. OS caches are not flushed. Profiling is a separate run.
 *
 * Acceptance: identical materialized bytes, zero shared-base object/pack growth
 * after N settled results, and no unexplained >=20% timing/CPU/allocation regression.
 * This owner does not read an agent DB; a 35 GiB DB would not exercise more work.
 * This is a real Git/worker-boundary fixture on the host filesystem, not a model
 * turn, Gateway transport, production run, or btrfs proof. Native Git CPU is measured by
 * the same /usr/bin/time shim in both arms. Inspector allocation is MAIN ISOLATE
 * ONLY; process CPU includes Node workers but excludes Git (reported separately).
 * Native CPU receipts have centisecond resolution per Git process.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { WorkerWorkspaceManifestEntry } from "../../src/gateway/worker-environments/workspace-manifest.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

type Fixture = {
  files: number;
  fileBytes: number;
  changedFiles: number;
  directories: number;
  existingPacks: number;
};
const [mode, directory, argument = "62000", fourth = "18000", fifth = "300"] =
  process.argv.slice(2);
assert(directory && (mode === "prepare" || mode === "run"));
const scratch = path.resolve(directory);
const seed = path.join(scratch, "seed.git");
const packSeed = path.join(scratch, "pack-seed.git");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const filename = (index: number) =>
  `source-${String(index % 43).padStart(2, "0")}/file-${String(index).padStart(6, "0")}.bin`;
const actualGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_SYSTEM = os.devNull;
const git = (root: string, ...args: string[]) =>
  execFileSync(actualGit, ["-c", `core.hooksPath=${os.devNull}`, "-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const positive = (value: string) => {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `Expected positive integer: ${value}`);
  return parsed;
};

if (mode === "prepare") {
  const fixture: Fixture = {
    files: positive(argument),
    fileBytes: positive(fourth),
    changedFiles: positive(fifth),
    directories: 43,
    existingPacks: 1500,
  };
  assert(fixture.changedFiles <= fixture.files);
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(seed);
  git(seed, "init", "--bare", "--quiet", "--template=", "--initial-branch=main");
  git(seed, "config", "uploadpack.allowFilter", "true");
  const inputPath = path.join(scratch, "seed.fast-import");
  const input = await fs.open(inputPath, "wx+");
  try {
    const content = Buffer.alloc(fixture.fileBytes, "synthetic baseline\n");
    const message = "Synthetic workspace baseline\n";
    await input.write(`blob\nmark :1\ndata ${content.length}\n`);
    await input.write(content);
    await input.write(
      `\ncommit refs/heads/main\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`,
    );
    for (let start = 0; start < fixture.files; start += 1000) {
      await input.write(
        Array.from(
          { length: Math.min(1000, fixture.files - start) },
          (_, offset) => `M 100644 :1 ${filename(start + offset)}\n`,
        ).join(""),
      );
    }
    await input.write("\ndone\n");
    await using reader = await fs.open(inputPath, "r");
    execFileSync(actualGit, ["-C", seed, "fast-import", "--quiet"], {
      stdio: [reader.fd, "pipe", "pipe"],
    });
  } finally {
    await input.close();
    await fs.rm(inputPath);
  }
  git(scratch, "init", "--bare", "--quiet", "--template=", packSeed);
  const checkpoints =
    Array.from({ length: fixture.existingPacks }, (_, index) => {
      const message = `Synthetic existing pack ${index}\n`;
      return `commit refs/heads/synthetic\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\ndata ${Buffer.byteLength(message)}\n${message}\ndeleteall\n\ncheckpoint\n`;
    }).join("") + "done\n";
  execFileSync(
    actualGit,
    ["-c", "fastimport.unpackLimit=0", "-C", packSeed, "fast-import", "--quiet"],
    { input: checkpoints },
  );
  await fs.writeFile(path.join(scratch, "fixture.json"), JSON.stringify(fixture));
  console.log(JSON.stringify({ fixture, logicalBytes: fixture.files * fixture.fileBytes }));
} else {
  const label = argument;
  const results = process.argv[5] === undefined ? 6 : positive(fourth);
  const instrument = process.argv[6] ?? "timing";
  assert(/^[A-Za-z0-9_-]+$/u.test(label));
  assert(["timing", "allocation", "cpu"].includes(instrument));
  assert(global.gc, "--expose-gc is required");
  const fixture: Fixture = JSON.parse(
    await fs.readFile(path.join(scratch, "fixture.json"), "utf8"),
  );
  const run = path.join(scratch, `${label}-fixture`);
  await fs.mkdir(run);
  const base = path.join(run, "base.git");
  const workspace = path.join(run, "workspace");
  const payload = path.join(run, "payload");
  const timings = path.join(run, "git-times");
  await fs.mkdir(payload);
  await fs.mkdir(timings);
  git(run, "clone", "--quiet", "--bare", "--filter=blob:none", pathToFileURL(seed).href, base);
  git(base, "config", "gc.auto", "0");
  git(base, "config", "maintenance.auto", "false");
  git(base, "worktree", "add", "--quiet", "--detach", workspace, "HEAD");
  // Existing unrelated packs model shared-base lookup pressure in both arms.
  await fs.cp(path.join(packSeed, "objects", "pack"), path.join(base, "objects", "pack"), {
    recursive: true,
  });
  const baseCommit = git(base, "rev-parse", "HEAD");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = path.join(run, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nexec /usr/bin/time -p -o ${quote(timings)}/$$.time ${quote(actualGit)} "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  if (process.env.OPENCLAW_BENCH_BASELINE_DIR) {
    await import("./worker-retained-heap-preload.js");
  }
  const {
    workerWorkspaceResultStaging,
    workerWorkspaceResultRef,
    withStagedWorkerWorkspaceResult,
    moveStagedWorkerWorkspaceResultToCleanup,
    deleteStagedWorkerWorkspaceResult,
  } = await import("../../src/gateway/worker-environments/workspace-result-staging.js");
  const { serializeWorkerWorkspaceManifest } =
    await import("../../src/gateway/worker-environments/workspace-manifest.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const baselineBytes = Buffer.alloc(fixture.fileBytes, "synthetic baseline\n");
  const baselineHash = hash(baselineBytes);
  const entries: WorkerWorkspaceManifestEntry[] = Array.from(
    { length: fixture.files },
    (_, index) => ({
      path: filename(index),
      type: "file",
      mode: 0o644,
      size: fixture.fileBytes,
      sha256: baselineHash,
    }),
  );
  const directories = Array.from(
    { length: Math.min(43, fixture.files) },
    (_, index) => `source-${String(index).padStart(2, "0")}`,
  );
  const baseRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit,
    entries,
    directories,
  });
  const baseRef = `sha256:${hash(baseRaw)}`;
  const packInventory = async () => {
    const packDirectory = path.join(base, "objects", "pack");
    const names = await fs.readdir(packDirectory);
    const packs = names.filter((name) => name.endsWith(".pack"));
    let bytes = 0;
    for (const name of packs) {
      bytes += (await fs.stat(path.join(packDirectory, name))).size;
    }
    const counts = Object.fromEntries(
      git(base, "count-objects", "-v")
        .split("\n")
        .map((line) => line.split(": ")),
    );
    return {
      packs: packs.length,
      packBytes: bytes,
      looseObjects: Number(counts.count),
      packedObjects: Number(counts["in-pack"]),
    };
  };
  const before = await packInventory();
  assert(before.packs >= fixture.existingPacks);
  const samples = [];
  const outputHash = createHash("sha256");
  const timeFiles = new Set<string>();
  try {
    for (let result = 0; result < results; result++) {
      const currentEntries = entries.slice();
      for (let index = 0; index < fixture.changedFiles; index++) {
        const bytes = Buffer.allocUnsafe(fixture.fileBytes);
        let state = ((result + 1) * 0x9e3779b1 + index + 1) >>> 0;
        for (let offset = 0; offset < bytes.length; offset++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          bytes[offset] = state & 0xff;
        }
        const target = path.join(payload, filename(index));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
        currentEntries[index] = {
          path: filename(index),
          type: "file",
          mode: 0o644,
          size: bytes.length,
          sha256: hash(bytes),
        };
      }
      const currentRaw = serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit,
        entries: currentEntries,
        directories,
      });
      const currentRef = `sha256:${hash(currentRaw)}`;
      const ref = workerWorkspaceResultRef(`synthetic-pack-${result}`);
      global.gc();
      const inspector = new Session();
      if (instrument === "allocation") {
        await startCollectedHeapSampling(inspector, 32768);
      }
      if (instrument === "cpu") {
        inspector.connect();
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      const loadBefore = os.loadavg();
      const cpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const started = performance.now();
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: workspace,
        stagingRoot: payload,
        stagedResultRef: ref,
        baseManifestRef: baseRef,
        currentManifestRef: currentRef,
        baseManifestRaw: baseRaw,
        currentManifestRaw: currentRaw,
      });
      const staged = performance.now();
      await withStagedWorkerWorkspaceResult(
        { root: workspace, stagedResultRef: ref },
        async (snapshot) => {
          assert.equal(snapshot.changedEntryCount, fixture.changedFiles);
          assert.equal(snapshot.currentManifestRef, currentRef);
          for (let index = 0; index < fixture.changedFiles; index++) {
            const entry = currentEntries[index]!;
            assert.equal(entry.type, "file");
            const actual = await fs.readFile(path.join(snapshot.stagingRoot, entry.path));
            assert(entry.type === "file" && hash(actual) === entry.sha256);
            outputHash.update(actual);
          }
        },
      );
      const materialized = performance.now();
      const cleanupRef = await moveStagedWorkerWorkspaceResultToCleanup({
        root: workspace,
        stagedResultRef: ref,
      });
      await deleteStagedWorkerWorkspaceResult({ root: workspace, stagedResultRef: cleanupRef });
      const ended = performance.now();
      const processCpu = process.cpuUsage(cpu);
      const mainCpu = process.threadCpuUsage(threadCpu);
      let mainSampledAllocatedBytes: number | undefined;
      if (instrument === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        mainSampledAllocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      }
      if (instrument === "cpu") {
        const { profile } = await inspector.post("Profiler.stop");
        await fs.writeFile(
          path.join(scratch, `${label}-${result}.cpuprofile`),
          JSON.stringify(profile),
        );
      }
      if (instrument !== "timing") {
        inspector.disconnect();
      }
      let nativeGitCpuMs = 0;
      let gitCommands = 0;
      for (const name of await fs.readdir(timings)) {
        if (timeFiles.has(name)) {
          continue;
        }
        timeFiles.add(name);
        const receipt = await fs.readFile(path.join(timings, name), "utf8");
        const user = /^user\s+(\d+(?:\.\d+)?)$/mu.exec(receipt);
        const system = /^sys\s+(\d+(?:\.\d+)?)$/mu.exec(receipt);
        assert(user && system, receipt);
        nativeGitCpuMs += (Number(user[1]) + Number(system[1])) * 1000;
        gitCommands++;
      }
      samples.push({
        result,
        temperature: result === 0 ? "cold-owner" : "warm-owner",
        loadBefore,
        loadAfter: os.loadavg(),
        stageMs: staged - started,
        materializeMs: materialized - staged,
        settleMs: ended - materialized,
        wallMs: ended - started,
        processCpuMs: (processCpu.user + processCpu.system) / 1000,
        mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
        nativeGitCpuMs,
        gitCommands,
        mainSampledAllocatedBytes,
        base: await packInventory(),
      });
    }
    const after = await packInventory();
    const warm = samples.slice(1);
    const warmSummary = Object.fromEntries(
      (
        [
          "stageMs",
          "materializeMs",
          "settleMs",
          "wallMs",
          "processCpuMs",
          "mainCpuMs",
          "nativeGitCpuMs",
          "mainSampledAllocatedBytes",
        ] as const
      ).map((metric) => {
        const values = warm
          .map((sample) => sample[metric])
          .filter((value): value is number => typeof value === "number")
          .toSorted((left, right) => left - right);
        return [
          metric,
          values.length
            ? {
                samples: values.length,
                min: values[0],
                median: values[Math.floor(values.length / 2)],
                p95: values[Math.ceil(values.length * 0.95) - 1],
                max: values.at(-1),
              }
            : null,
        ];
      }),
    );
    const report = {
      label,
      instrument,
      baseline: Boolean(process.env.OPENCLAW_BENCH_BASELINE_DIR),
      node: process.version,
      platform: process.platform,
      fixture,
      logicalWorkspaceBytes: fixture.files * fixture.fileBytes,
      resultBytes: fixture.changedFiles * fixture.fileBytes,
      before,
      after,
      packGrowth: after.packs - before.packs,
      packByteGrowth: after.packBytes - before.packBytes,
      looseObjectGrowth: after.looseObjects - before.looseObjects,
      samples,
      warmSummary,
      outputDigest: outputHash.digest("hex"),
    };
    await fs.writeFile(path.join(scratch, `${label}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await drainGlobalSingletonLifecycleState();
    await fs.rm(run, { recursive: true, force: true });
  }
}
