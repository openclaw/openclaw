// Disposable Linux btrfs proof. Bundle src/infra/fs-safe-copy.worker.ts, then run:
// Bundle src/agents/worktrees/filesystem-native.ts as the owner, preserving native packages;
// keep src/state/openclaw-{agent,state}-schema.sql beside that owner bundle.
// node scripts/perf/template-retirement-measure.mts --root /mnt/disposable --child /path/worker.mjs --owner /path/owner.mjs --dependencies /path/node_modules
// Repeat separately with --allocation. --profile captures a diagnostic pair, excluded from timing.
// Acceptance: 62,000 files / 1,100,004,000 bytes, two A/A controls + five interleaved pairs;
// >90% less main-isolate JS allocation, lower total CPU/wall, and no >20% timing regression.
// Child allocations/CPU and explicit btrfs deletion settlement are reported separately.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { copyTree, createCloneSource, probeTreeClone } from "@openclaw/fs-safe/copy";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const parent = args.includes("--root") ? option("--root") : undefined;
const child = args.includes("--child") ? option("--child") : undefined;
const owner = args.includes("--owner") ? option("--owner") : undefined;
assert(
  parent && child && owner,
  "Pass --root (disposable btrfs directory), --child and --owner (production bundles)",
);
const dependencies = args.includes("--dependencies") ? option("--dependencies") : undefined;
assert(dependencies, "Pass --dependencies with the native packages' node_modules directory");
const dependencyRoot = fs.realpathSync(dependencies);
assert(fs.statSync(dependencyRoot).isDirectory(), "--dependencies must be a directory");
const allocation = args.includes("--allocation");
const profile = args.includes("--profile");
const pairs = profile ? 1 : 5;
configureFsSafeNative({ mode: "require" });
assert.equal(probeTreeClone(parent), "btrfs");
const root = fs.mkdtempSync(path.join(path.resolve(parent), "template-retirement-bench-"));
const source = path.join(root, "template");
const target = path.join(root, "retiring");
const proof = args.includes("--out") ? path.resolve(option("--out")!) : process.cwd();
fs.mkdirSync(proof, { recursive: true });
const metricsFile = path.join(root, "child-metrics.json");
const runtime = path.join(root, "runtime");
fs.mkdirSync(path.join(runtime, "dist/infra"), { recursive: true });
fs.symlinkSync(dependencyRoot, path.join(runtime, "node_modules"), "dir");
fs.writeFileSync(path.join(runtime, "package.json"), '{"type":"module"}\n');
const childCopy = path.join(runtime, "dist/infra/fs-safe-copy.worker.actual.mjs");
const ownerCopy = path.join(runtime, "dist/filesystem-native.mjs");
fs.copyFileSync(child, childCopy);
fs.copyFileSync(owner, ownerCopy);
for (const asset of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
  fs.copyFileSync(path.join(path.dirname(owner), asset), path.join(runtime, "dist", asset));
}
const wrapper = path.join(runtime, "dist/infra/fs-safe-copy.worker.js");
const { nativeWorktreeFilesystem } = await import(pathToFileURL(ownerCopy).href);
const command = (exe: string, argv: string[]) =>
  execFileSync(exe, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const settle = () => {
  command("btrfs", ["filesystem", "sync", root]);
  command("btrfs", ["subvolume", "sync", root]);
};
type AllocationNode = { selfSize: number; children: AllocationNode[] };
const sum = (node: AllocationNode): number =>
  node.selfSize + node.children.reduce((total, entry) => total + sum(entry), 0);
const inspector = new Session();
inspector.connect();
const rows: Record<string, unknown>[] = [];
fs.writeFileSync(
  wrapper,
  `
import fs from 'node:fs';
import { Session } from 'node:inspector/promises';
const inspector = new Session(); inspector.connect();
const sum = n => n.selfSize + n.children.reduce((s,c) => s+sum(c),0);
if (${allocation}) await inspector.post('HeapProfiler.startSampling', {samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
if (${profile}) { await inspector.post('Profiler.enable'); await inspector.post('Profiler.start'); }
await import(${JSON.stringify(pathToFileURL(childCopy).href)});
const usage = process.resourceUsage();
const heap = ${allocation} ? await inspector.post('HeapProfiler.stopSampling') : null;
if (${profile}) fs.writeFileSync(${JSON.stringify(path.join(proof, "child.cpuprofile"))},JSON.stringify((await inspector.post('Profiler.stop')).profile));
fs.writeFileSync(${JSON.stringify(metricsFile)}, JSON.stringify({childCpuMs:(usage.userCPUTime+usage.systemCPUTime)/1000,childMaxRssKiB:usage.maxRSS,childSampledJsBytes:heap?sum(heap.profile.head):null}));
inspector.disconnect();
`,
);

async function sample(kind: "baseline" | "candidate", label: string) {
  await copyTree(source, target, { clone: "always" });
  settle();
  assert.equal(fs.statSync(target).ino, 256);
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await setTimeout(15);
  histogram.reset();
  if (allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (profile) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const load = loadavg();
  const before = process.cpuUsage();
  const start = performance.now();
  if (kind === "baseline") {
    await fsp.rm(target, { recursive: true, force: true });
  } else {
    await nativeWorktreeFilesystem.remove(target, { commitGuard: () => {} });
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(before);
  const heap = allocation ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  if (profile) {
    fs.writeFileSync(
      path.join(proof, `${kind}.cpuprofile`),
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  await setTimeout(5);
  histogram.disable();
  assert(!fs.existsSync(target));
  assert.equal(fs.readFileSync(path.join(source, "src/group-0/file-0.txt")).length, 17742);
  const settlementStart = performance.now();
  settle();
  const settleMs = performance.now() - settlementStart;
  const childMetrics = kind === "candidate" ? JSON.parse(fs.readFileSync(metricsFile, "utf8")) : {};
  const parentCpuMs = (cpu.user + cpu.system) / 1000;
  const childCpuMs = Number(childMetrics.childCpuMs ?? 0);
  const row = {
    kind,
    label,
    allocation,
    profile,
    wallMs,
    settleMs,
    completeWallMs: wallMs + settleMs,
    parentCpuMs,
    childCpuMs,
    totalCpuMs: parentCpuMs + childCpuMs,
    sampledJsBytes: heap ? sum(heap.profile.head) : null,
    ...childMetrics,
    mainStallP95Ms: histogram.percentile(95) / 1e6,
    mainStallMaxMs: histogram.max / 1e6,
    load,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

try {
  await createCloneSource(source);
  const payload = Buffer.alloc(17742, 120);
  for (let i = 0; i < 62000; i++) {
    const directory = path.join(
      source,
      i < 2000 ? "src" : "node_modules/.pnpm",
      `group-${Math.floor(i / 100)}`,
    );
    if (i % 100 === 0) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(directory, `file-${i}.txt`), payload);
  }
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(
    path.join(source, "package.json"),
    '{"name":"synthetic-template","private":true}\n',
  );
  fs.writeFileSync(
    path.join(source, "pnpm-lock.yaml"),
    'lockfileVersion: "9.0"\nimporters:\n  .: {}\n',
  );
  command("git", ["-C", source, "init", "-q", "-b", "template"]);
  command("git", ["-C", source, "add", "."]);
  command("git", [
    "-C",
    source,
    "-c",
    "user.name=Synthetic Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "synthetic fixture",
  ]);
  settle();
  if (!profile) {
    await sample("baseline", "aa1");
    await sample("baseline", "aa2");
  }
  for (let pair = 1; pair <= pairs; pair++) {
    const order =
      pair % 2 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
    for (const kind of order) {
      await sample(kind, `pair-${pair}`);
    }
  }
  fs.writeFileSync(
    path.join(proof, profile ? "profile.json" : allocation ? "allocation.json" : "timing.json"),
    JSON.stringify(
      {
        node: process.version,
        fixture: {
          files: 62000,
          payloadBytes: 1100004000,
          sourceFiles: 2000,
          dependencyFiles: 60000,
        },
        scope:
          "Exact bundled filesystem-native remove owner and production child entrypoint; includes command supervisor/receipt, excludes template registry/shared-state admission. Warm metadata, no OS cache eviction. Child resourceUsage includes startup through deletion completion; V8 sampling estimates JS allocation only.",
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
  for (const directory of [target, source]) {
    if (fs.existsSync(directory)) {
      command("btrfs", ["subvolume", "delete", directory]);
    }
  }
  settle();
  fs.rmSync(root, { recursive: true, force: true });
}
