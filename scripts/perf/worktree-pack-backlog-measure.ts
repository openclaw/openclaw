/**
 * Scheduler/native-Git proof for a lazy-fetch burst while checkout cleanup waits on IO.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-pack-backlog-measure.ts \
 *   --output /absolute/owned/fixture --prepare
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-pack-backlog-measure.ts \
 *   --output /absolute/owned/fixture --report candidate-1.json [--profile]
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse original-source overlay. Run serially:
 * five A/A pairs, then five counterbalanced A/B pairs, each in a fresh process.
 * Acceptance: baseline remains at 1,633 packs; candidate approaches the 1,033-pack
 * baseline within one virtual hour, preserving the exact object set. Report CPU,
 * allocation as work costs, not speedups over no work. Checkout-lease latency is
 * covered by the existing lease-yielding benchmark rather than repeated here.
 * The 1,033 baseline packs are pinned, NOT fabricated giant packs; the 600 new
 * promisor packs contain deterministic incompressible 64-KiB blobs. Real 62k-file,
 * 1.1-GB checkout and 3k registry rows; no 35-GiB agent DB or production data.
 * Only host pressure and the cleanup entry boundary are simulated. The Gateway
 * scheduler, maintenance owner, registry, leases, content slots and Git are real.
 * The wrapper enters the existing beforeRemoval hook before ordinary GC; it does
 * not claim to exercise candidate classification or actual checkout removal.
 * Setup, pack restoration, warmup and object verification are outside measurement.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { crc32, deflateSync } from "node:zlib";
import type { ManagedWorktreeRecord } from "../../src/agents/worktrees/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    prepare: { type: "boolean", default: false },
    report: { type: "string", default: "report.json" },
    profile: { type: "boolean", default: false },
    files: { type: "string", default: "62000" },
    records: { type: "string", default: "3000" },
  },
});
assert(values.output && global.gc, "--output and --expose-gc are required");
assert(process.platform === "darwin" || process.platform === "linux");
const output = path.resolve(values.output);
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const manifestPath = path.join(output, "fixture.json");
const reportPath = path.resolve(output, values.report);
const repo = path.join(output, "repo");
const packDir = path.join(repo, ".git", "objects", "pack");
const savedPacks = path.join(output, "baseline-packs");
const burstPacks = path.join(output, "burst-packs");
const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
if (values.prepare) {
  assert(!fs.existsSync(manifestPath), "Refusing to replace an existing fixture");
}
for (const name of ["home", "tmp", "state", "bin"]) {
  fs.mkdirSync(path.join(output, name), { recursive: true });
}
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
  },
});
fs.writeFileSync(configPath, "{}");
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
let pressureChecks = 0;
const entered = Promise.withResolvers<void>();
Object.assign(globalThis, {
  __packBacklogPressure: () => {
    pressureChecks++;
    entered.resolve();
    return true;
  },
});
registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith("/host-io-pressure.ts")
      ? {
          format: "module",
          source:
            "export function createHostIoPressureProbe() { return async () => globalThis.__packBacklogPressure(); }",
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});
const git = (args: string[], input?: string) =>
  execFileSync(nativeGit, ["-C", repo, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot({});
const { managedWorktrees } = await import("../../src/agents/worktrees/service.js");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { createGatewaySchedulerClock, createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { startWorktreeMaintenance } = await import("../../src/gateway/worktree-maintenance.js");

// Write standard one-blob pack/index v2 files; native Git verifies them before use.
function singletonPack(directory: string, contents: Buffer, kept: boolean) {
  const oid = sha1(Buffer.concat([Buffer.from(`blob ${contents.length}\0`), contents]));
  let remaining = contents.length >>> 4;
  const header = [0x30 | (contents.length & 15) | (remaining ? 0x80 : 0)];
  while (remaining) {
    const part = remaining & 127;
    remaining >>>= 7;
    header.push(part | (remaining ? 128 : 0));
  }
  const entry = Buffer.concat([Buffer.from(header), deflateSync(contents)]);
  const body = Buffer.concat([Buffer.from("5041434b0000000200000001", "hex"), entry]);
  const hash = sha1(body);
  const stem = path.join(directory, `pack-${hash.toString("hex")}`);
  const index = Buffer.alloc(8 + 1024 + 20 + 4 + 4 + 20);
  index.writeUInt32BE(0xff744f63);
  index.writeUInt32BE(2, 4);
  for (let bucket = oid[0]!; bucket < 256; bucket++) {
    index.writeUInt32BE(1, 8 + bucket * 4);
  }
  oid.copy(index, 1032);
  index.writeUInt32BE(crc32(entry), 1052);
  index.writeUInt32BE(12, 1056);
  hash.copy(index, 1060);
  fs.writeFileSync(`${stem}.pack`, Buffer.concat([body, hash]));
  fs.writeFileSync(`${stem}.idx`, Buffer.concat([index, sha1(index)]));
  fs.writeFileSync(`${stem}.${kept ? "keep" : "promisor"}`, "");
}
const packCount = () => fs.readdirSync(packDir).filter((name) => name.endsWith(".pack")).length;
const objectDigest = () => {
  const objects = git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n")
    .toSorted();
  return {
    count: objects.length,
    sha256: createHash("sha256").update(objects.join("\n")).digest("hex"),
  };
};
type Fixture = { files: number; fileBytes: number; records: number; record: ManagedWorktreeRecord };
let stopMeasurement: (() => Promise<void>) | undefined;
try {
  if (values.prepare) {
    const files = Number(values.files);
    const records = Number(values.records);
    assert(Number.isSafeInteger(files) && files > 0);
    assert(Number.isSafeInteger(records) && records > 0);
    const fileBytes = 18_000;
    fs.mkdirSync(repo);
    git(["init", "--quiet", "-b", "main"]);
    git(["config", "user.name", "Synthetic Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "gc.auto", "0"]);
    git(["config", "maintenance.auto", "false"]);
    for (let index = 0; index < files; index++) {
      const directory = path.join(repo, `package-${Math.floor(index / 100)}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, `file-${index}.txt`),
        `synthetic ${index}\n`.padEnd(fileBytes, "x"),
      );
    }
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "Synthetic pack-backlog workspace"]);
    git(["repack", "-ad"]);
    const basePack = fs.readdirSync(packDir).find((name) => name.endsWith(".pack"))!;
    fs.writeFileSync(path.join(packDir, basePack.replace(/\.pack$/, ".keep")), "");
    for (let index = 0; index < 1032; index++) {
      singletonPack(packDir, Buffer.from(`pinned baseline object ${index}\n`), true);
    }
    fs.cpSync(packDir, savedPacks, { recursive: true });
    fs.mkdirSync(burstPacks);
    const cipher = createCipheriv("aes-256-ctr", Buffer.alloc(32, 17), Buffer.alloc(16, 23));
    for (let index = 0; index < 600; index++) {
      singletonPack(burstPacks, cipher.update(Buffer.alloc(64 * 1024)), false);
    }
    // Native verification is independent of the benchmark's pack/index encoder.
    for (const directory of [packDir, burstPacks]) {
      const names = fs.readdirSync(directory).filter((name) => name.endsWith(".pack"));
      for (let offset = 0; offset < names.length; offset += 128) {
        execFileSync(
          nativeGit,
          ["-C", directory, "verify-pack", ...names.slice(offset, offset + 128)],
          {
            env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) },
            stdio: "pipe",
          },
        );
      }
    }
    let record: ManagedWorktreeRecord | undefined;
    for (let index = 0; index < records; index++) {
      record = {
        id: `pack-backlog-${index}`,
        name: `synthetic-${index}`,
        repoFingerprint: "pack-backlog",
        repoRoot: repo,
        path: path.join(output, "registry-only", String(index)),
        branch: `synthetic-${index}`,
        baseRef: "main",
        ownerKind: "session",
        ownerId: `agent:main:synthetic-${index}`,
        createdAt: 1,
        lastActiveAt: 1,
      };
      await insertRegistryWorktree(process.env, record);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ files, fileBytes, records, record }));
    console.log(JSON.stringify({ prepared: true, files, fileBytes, records, packs: packCount() }));
  } else {
    assert(!fs.existsSync(reportPath), "Refusing to overwrite a report");
    const fixture: Fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // This path is exclusively created by --prepare; restore the identical inputs per sample.
    fs.rmSync(packDir, { recursive: true });
    fs.cpSync(savedPacks, packDir, { recursive: true });
    await managedWorktrees.maintainGit({});
    assert.equal(packCount(), 1033);
    fs.cpSync(burstPacks, packDir, { recursive: true });
    const beforeObjects = objectDigest();
    const beforePacks = packCount();
    const nativeMetrics = path.join(output, `${values.report}.native`);
    fs.mkdirSync(nativeMetrics);
    const measureFlag = path.join(nativeMetrics, "measured");
    const timeArgs =
      process.platform === "darwin" ? "-l" : "-f '%e real %U user %S sys %M rss-kib'";
    const wrapper = path.join(output, "bin", "git");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ -n "$OPENCLAW_BENCH_GIT_CHILD" ] || [ ! -f ${shellQuote(measureFlag)} ]; then exec ${shellQuote(nativeGit)} "$@"; fi\nexport OPENCLAW_BENCH_GIT_CHILD=1\nprintf '%s\\n' "$@" > ${shellQuote(nativeMetrics)}/git-$$.args\nexec /usr/bin/time ${timeArgs} -o ${shellQuote(nativeMetrics)}/git-$$.time ${shellQuote(nativeGit)} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${path.dirname(wrapper)}${path.delimiter}${process.env.PATH}`;
    const originalGc = managedWorktrees.gc.bind(managedWorktrees);
    managedWorktrees.gc = async (params) => {
      await params?.beforeRemoval?.(fixture.record);
      return originalGc(params);
    };
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const errors: string[] = [];
    const completions: unknown[] = [];
    const owner = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig: () => ({}),
      onComplete: (result) => completions.push(result),
      onError: (error) => errors.push(error),
    });
    const receipt = owner.request();
    const cleanup = clock.advanceBy(0);
    stopMeasurement = async () => {
      await owner.stop();
      await cleanup;
      await scheduler.stop();
      managedWorktrees.gc = originalGc;
    };
    await entered.promise;
    const inspector = new Session();
    if (values.profile) {
      inspector.connect();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    global.gc();
    const loadBefore = os.loadavg();
    const measuredNative = new Set<string>();
    const tick = async () => {
      const allocationBefore = getHeapStatistics().total_allocated_bytes;
      const cpuBefore = process.cpuUsage();
      const threadBefore = process.threadCpuUsage();
      fs.writeFileSync(measureFlag, "");
      const started = performance.now();
      await clock.advanceBy(5 * 60_000);
      const wallMs = performance.now() - started;
      fs.unlinkSync(measureFlag);
      const processCpu = process.cpuUsage(cpuBefore);
      const threadCpu = process.threadCpuUsage(threadBefore);
      const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
      assert(Number.isFinite(allocatedBytes), "Node must expose exact V8 allocation counters");
      const native = fs
        .readdirSync(nativeMetrics)
        .filter((name) => name.endsWith(".time") && !measuredNative.has(name))
        .map((name) => {
          measuredNative.add(name);
          const raw = fs.readFileSync(path.join(nativeMetrics, name), "utf8");
          const match = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(raw);
          assert(match, raw);
          const rss =
            process.platform === "darwin"
              ? Number(/(\d+)\s+maximum resident set size/.exec(raw)?.[1])
              : Number(/(\d+) rss-kib/.exec(raw)?.[1]) * 1024;
          const args = fs.readFileSync(
            path.join(nativeMetrics, name.replace(/\.time$/, ".args")),
            "utf8",
          );
          return {
            cpuMs: (Number(match[2]) + Number(match[3])) * 1000,
            rss,
            consolidation: args.split("\n").includes("openclaw-consolidate"),
          };
        });
      return {
        afterPacks: packCount(),
        wallMs,
        processCpuMs: (processCpu.user + processCpu.system) / 1000,
        mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
        allocatedBytes,
        nativeCommands: native.length,
        nativeCpuMs: native.reduce((sum, row) => sum + row.cpuMs, 0),
        nativePeakRssBytes: Math.max(0, ...native.map((row) => row.rss)),
        consolidations: native.filter((row) => row.consolidation).length,
      };
    };
    const ticks: Array<Awaited<ReturnType<typeof tick>>> = [];
    do {
      ticks.push(await tick());
    } while (ticks.at(-1)!.afterPacks > 1036 && ticks.length < 12);
    const afterPacks = packCount();
    if (baseline) {
      assert.equal(afterPacks, 1633, "Historical scheduler unexpectedly made progress");
    } else {
      assert(afterPacks <= 1036, "Backlog did not drain within one virtual hour");
    }
    const quiescent = await tick();
    assert.equal(quiescent.afterPacks, afterPacks, "Quiescent interval rewrote packs");
    assert.equal(
      quiescent.consolidations,
      0,
      "Quiescent interval reconsolidated below-threshold packs",
    );
    assert.deepEqual(objectDigest(), beforeObjects, "Consolidation changed the object set");
    assert.equal(
      owner.request({ jobId: receipt.jobId }).state,
      "running",
      "Cleanup must remain blocked",
    );
    if (values.profile) {
      fs.writeFileSync(
        `${reportPath}.cpuprofile`,
        JSON.stringify((await inspector.post("Profiler.stop")).profile),
      );
      inspector.disconnect();
    }
    const sourceDigest = createHash("sha256");
    for (const relative of [
      "src/gateway/worktree-maintenance.ts",
      "src/agents/worktrees/git-maintenance.ts",
      "src/agents/worktrees/service.ts",
    ]) {
      const original = baseline && path.join(baseline, relative);
      sourceDigest.update(
        fs.readFileSync(
          original && fs.existsSync(original)
            ? original
            : fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
        ),
      );
    }
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          baseline: baseline ?? null,
          sourceDigest: sourceDigest.digest("hex"),
          node: process.version,
          platform: process.platform,
          files: fixture.files,
          checkoutBytes: fixture.files * fixture.fileBytes,
          registryRows: fixture.records,
          baselinePacks: 1033,
          burstPacks: 600,
          burstBytes: 600 * 64 * 1024,
          beforePacks,
          afterPacks,
          beforeObjects,
          virtualElapsedMs: ticks.length * 300_000,
          wallMs: ticks.reduce((sum, row) => sum + row.wallMs, 0),
          processCpuMs: ticks.reduce((sum, row) => sum + row.processCpuMs, 0),
          mainThreadCpuMs: ticks.reduce((sum, row) => sum + row.mainThreadCpuMs, 0),
          allocatedBytes: ticks.reduce((sum, row) => sum + row.allocatedBytes, 0),
          nativeCommands: ticks.reduce((sum, row) => sum + row.nativeCommands, 0),
          nativeCpuMs: ticks.reduce((sum, row) => sum + row.nativeCpuMs, 0),
          nativePeakRssBytes: Math.max(0, ...ticks.map((row) => row.nativePeakRssBytes)),
          ticks,
          quiescent,
          pressureChecks,
          completions,
          errors,
          loadBefore,
          loadAfter: os.loadavg(),
        },
        null,
        2,
      ),
    );
    console.log(fs.readFileSync(reportPath, "utf8"));
  }
} finally {
  await stopMeasurement?.();
  await closeOpenClawStateDatabaseAsync();
}
