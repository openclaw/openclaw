/**
 * Real settled-publication owner, real Git, synthetic workspace; no Gateway or GitHub traffic.
 * node --import ./scripts/tsx.mjs scripts/perf/github-publication-snapshot-measure.ts --fixture /proof/workspace --create
 * Freeze the baseline next to its owner so relative imports retain the same dependency graph:
 * git show HEAD:src/gateway/github-publication-git-transport.ts > src/gateway/github-publication-git-transport.baseline.ts
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/github-publication-snapshot-measure.ts --fixture /proof/workspace --base-module src/gateway/github-publication-git-transport.baseline.ts --samples 5
 * Add --allocations for a separate sampled-allocation campaign, or --control for A/A.
 * --balanced alternates AB/BA order across pairs to check order effects.
 * Acceptance: identical snapshot and unchanged source index, lower sampled allocation,
 * no >=20% increase in median/p95 CPU or wall time. First captures and warm captures
 * are reported separately. Five paired samples are the minimum; p95 is their maximum.
 * Reads of PR-panel/options metadata do not invoke this owner. This measures capture,
 * not a fabricated polling rate. The owner does not access agent databases.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { captureSettledGitHubPublicationWorkspaceSnapshot } from "../../src/gateway/github-publication-git-transport.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    create: { type: "boolean", default: false },
    "base-module": { type: "string" },
    "candidate-module": {
      type: "string",
      default: "src/gateway/github-publication-git-transport.ts",
    },
    samples: { type: "string", default: "5" },
    allocations: { type: "boolean", default: false },
    control: { type: "boolean", default: false },
    balanced: { type: "boolean", default: false },
    "cpu-profile": { type: "string" },
  },
});
assert(values.fixture, "--fixture is required");
const root = path.resolve(values.fixture);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });

if (values.create) {
  fs.mkdirSync(root);
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "pack.threads", "1"]);
  const payload = Buffer.alloc(18_432, 0x78);
  for (let index = 0; index < 62_000; index++) {
    const directory = path.join(root, "tracked", `d${Math.floor(index / 100)}`);
    if (index % 100 === 0) {
      fs.mkdirSync(directory, { recursive: true });
    }
    payload.writeUInt32LE(index);
    fs.writeFileSync(path.join(directory, `f${index}.txt`), payload);
  }
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "synthetic publication workspace",
  ]);
  // These host-only files must never be enrolled by publication's temporary staging.
  for (const name of ["excluded.txt", "excluded\tline\n.txt", "excluded-é.txt"]) {
    fs.writeFileSync(path.join(root, name), "synthetic unadmitted bytes\n");
  }
  console.log(
    JSON.stringify({ fixture: root, trackedFiles: 62_000, bytes: 62_000 * payload.length }),
  );
} else {
  assert(values["base-module"], "--base-module is required");
  const samples = Number(values.samples);
  assert(Number.isInteger(samples) && samples >= 5, "Use at least five interleaved pairs");
  const basePath = path.resolve(values["base-module"]);
  const candidatePath = path.resolve(values["candidate-module"]);
  const modules = [basePath, values.control ? basePath : candidatePath];
  const provenance = modules.map((module) => ({
    path: module,
    sha256: hash(fs.readFileSync(module)),
  }));
  const owners: Array<typeof captureSettledGitHubPublicationWorkspaceSnapshot> = [];
  for (const module of modules) {
    owners.push(
      (await import(pathToFileURL(module).href)).captureSettledGitHubPublicationWorkspaceSnapshot,
    );
  }
  const admitted = new Set(git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean));
  const sourceHeadCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  const sourceIndexTree = git(["write-tree"]).toString("utf8").trim();
  const sourceIndex = path.resolve(
    root,
    git(["rev-parse", "--git-path", "index"]).toString("utf8").trim(),
  );
  const indexHash = hash(fs.readFileSync(sourceIndex));
  const expected = { sourceHeadCommit, sourceIndexTree, workspaceTree: sourceIndexTree };
  const inspector = new Session();
  inspector.connect();
  if (values["cpu-profile"]) {
    assert(!values.allocations, "CPU and allocation profiles must run separately");
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const results: Array<{
    arm: string;
    phase: string;
    pair: number;
    wallMs: number;
    mainThreadCpuMs: number;
    processCpuMs: number;
    sampledBytes?: number;
    load: number[];
  }> = [];
  for (let pair = -1; pair < samples; pair++) {
    const order = values.balanced && pair >= 0 && pair % 2 === 1 ? [1, 0] : [0, 1];
    for (const arm of order) {
      global.gc?.();
      if (values.allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const load = os.loadavg();
      const cpu = process.cpuUsage();
      const mainThreadCpu = process.threadCpuUsage();
      const started = performance.now();
      const actual = await owners[arm]!({ cwd: root }, undefined, admitted);
      const wallMs = performance.now() - started;
      const usedThread = process.threadCpuUsage(mainThreadCpu);
      const usedProcess = process.cpuUsage(cpu);
      const sampledBytes = values.allocations
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (sum, sample) => sum + sample.size,
            0,
          )
        : undefined;
      assert.deepEqual(actual, expected);
      assert.equal(hash(fs.readFileSync(sourceIndex)), indexHash);
      const result = {
        arm: arm === 0 ? "baseline" : values.control ? "control" : "candidate",
        phase: pair < 0 ? "first" : "warm",
        pair,
        wallMs,
        mainThreadCpuMs: (usedThread.user + usedThread.system) / 1000,
        processCpuMs: (usedProcess.user + usedProcess.system) / 1000,
        sampledBytes,
        load,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  if (values["cpu-profile"]) {
    const { profile } = await inspector.post("Profiler.stop");
    fs.writeFileSync(values["cpu-profile"], JSON.stringify(profile));
  }
  inspector.disconnect();
  for (const module of provenance) {
    assert.equal(hash(fs.readFileSync(module.path)), module.sha256, "Owner changed during capture");
  }
  const summary = (numbers: number[]) => {
    const sorted = numbers.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  console.log(
    JSON.stringify({
      fixture: root,
      node: process.version,
      platform: process.platform,
      files: admitted.size,
      samples,
      allocations: values.allocations,
      control: values.control,
      balanced: values.balanced,
      modules: provenance,
      snapshot: expected,
      summary: [...new Set(results.map((row) => row.arm))].map((arm) => {
        const warm = results.filter((row) => row.arm === arm && row.phase === "warm");
        return {
          arm,
          wallMs: summary(warm.map((row) => row.wallMs)),
          mainThreadCpuMs: summary(warm.map((row) => row.mainThreadCpuMs)),
          processCpuMs: summary(warm.map((row) => row.processCpuMs)),
          sampledBytes: values.allocations
            ? summary(warm.map((row) => row.sampledBytes!))
            : undefined,
        };
      }),
    }),
  );
}
