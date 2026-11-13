// Measure completion-custody settlement in a pinned source checkout.
// node --expose-gc --import ./scripts/tsx.mjs /absolute/subagent-custody-settlement.mjs \
//   /absolute/source-root /absolute/fresh-output-directory [allocation]
// Preparation/GC outside timing. Tiny authority release callback deliberately
// excludes full operator/source destructor cost; the real Map owner is imported.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const [sourceArg, outputArg, mode = "timing"] = process.argv.slice(2);
assert(sourceArg && outputArg && ["timing", "allocation"].includes(mode));
assert(global.gc, "Use --expose-gc");
const sourceRoot = path.resolve(sourceArg);
const outputRoot = path.resolve(outputArg);
await fs.mkdir(outputRoot); // Require a fresh task-owned output directory.
process.env.OPENCLAW_HOME = path.join(outputRoot, "home");
process.env.OPENCLAW_STATE_DIR = path.join(outputRoot, "state");
process.env.OPENCLAW_AGENT_DIR = path.join(outputRoot, "state", "agents", "main", "agent");
process.env.OPENCLAW_CONFIG_PATH = path.join(outputRoot, "openclaw.json");
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}\n");
const ownerFile = path.join(
  sourceRoot,
  "src/agents/subagents/registry/subagent-registry-memory.ts",
);
const { subagentRuns } = await import(pathToFileURL(ownerFile).href);
assert.equal(subagentRuns.size, 0, "Fresh process must have no registry rows");
let releases = 0;
function prepareBatch(start) {
  return Array.from({ length: 10 }, (_, offset) => {
    const index = start + offset;
    const runId = `owner-bench-${index}`;
    const entry = {
      runId,
      generation: 1,
      childAgentId: "main",
      requesterAgentId: "main",
      childSessionKey: `agent:main:subagent:${index}`,
      requesterSessionKey: `agent:main:parent:${index}`,
      requesterDisplayKey: "synthetic",
      requesterTurnRunId: `parent-turn-${index}`,
      task: "synthetic",
      cleanup: "keep",
      createdAt: index + 1,
      expectsCompletionMessage: false,
      execution: { status: "terminal", endedAt: index + 2, outcome: { status: "ok" } },
      cleanupCompletedAt: index + 3,
      delivery: { status: "not_required" },
    };
    subagentRuns.set(runId, entry);
    const signal = new AbortController().signal;
    subagentRuns.bindCompletionAuthority(entry, {
      signal,
      assertCurrent() {
        signal.throwIfAborted();
      },
      release() {
        releases++;
      },
    });
    return [runId]; // The actual publication caller supplies changed run IDs.
  });
}
async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    global.gc();
  }
}
for (let warm = 0; warm < 2; warm++) {
  for (let index = 0; index < 1000; index += 10) {
    for (const changed of prepareBatch(index)) {
      subagentRuns.settleCompletionAuthorities(subagentRuns, changed);
    }
  }
  subagentRuns.clear();
  assert.equal(releases, 1000);
  releases = 0;
}
await collect();
const inspector = new Session();
const sampling = {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
};
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", sampling);
}
const trials = [];
for (let trial = 0; trial < 20; trial++) {
  const rounds = [];
  releases = 0;
  for (let round = 0; round < 4; round++) {
    const hostLoadBefore = loadavg();
    let wallMs = 0,
      cpuUs = 0;
    const batches = [];
    for (let start = round * 250; start < (round + 1) * 250; start += 10) {
      const batch = prepareBatch(start);
      const cpu = process.threadCpuUsage();
      const began = performance.now();
      for (const changed of batch) {
        subagentRuns.settleCompletionAuthorities(subagentRuns, changed);
      }
      const elapsedMs = performance.now() - began;
      const used = process.threadCpuUsage(cpu);
      const usedUs = used.user + used.system;
      wallMs += elapsedMs;
      cpuUs += usedUs;
      batches.push({ completed: start + 10, wallMs: elapsedMs, cpuUs: usedUs });
    }
    assert.equal(subagentRuns.size, (round + 1) * 250);
    rounds.push({
      completed: subagentRuns.size,
      releases,
      unreleased: subagentRuns.size - releases,
      ownerWallMs: wallMs,
      ownerCpuUs: cpuUs,
      ownerWallUsPerCompletion: wallMs * 4,
      ownerCpuUsPerCompletion: cpuUs / 250,
      batches,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    });
  }
  subagentRuns.clear();
  assert.equal(releases, 1000, "Explicit teardown must release every authority exactly once");
  trials.push({ trial, rounds, cleanupReleases: releases });
  await collect();
}
let allocation;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await fs.writeFile(
    path.join(outputRoot, "allocation.heapprofile"),
    JSON.stringify(profile) + "\n",
  );
  let totalBytes = 0,
    ownerInclusiveBytes = 0,
    matchedOwnerFrames = 0;
  const ownerFrameLocations = new Map();
  const ownerSites = new Map();
  function visit(node, inside = false) {
    const matches = node.callFrame.functionName === "settleCompletionAuthorities";
    if (matches) {
      matchedOwnerFrames++;
      ownerFrameLocations.set(JSON.stringify(node.callFrame), node.callFrame);
    }
    const active = inside || matches;
    totalBytes += node.selfSize;
    if (active) {
      ownerInclusiveBytes += node.selfSize;
      if (node.selfSize) {
        const site = JSON.stringify(node.callFrame);
        ownerSites.set(site, (ownerSites.get(site) ?? 0) + node.selfSize);
      }
    }
    for (const child of node.children) {
      visit(child, active);
    }
  }
  visit(profile.head);
  allocation = {
    sampling,
    totalBytes,
    matchedOwnerFrames,
    ownerFrameLocations: [...ownerFrameLocations.values()],
    ownerSites: [...ownerSites]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([site, bytes]) => ({ frame: JSON.parse(site), bytes })),
    qualification:
      matchedOwnerFrames > 0 ? "owner-frame-observed" : "owner-frame-absent-unmeasured",
    ownerInclusiveBytes: matchedOwnerFrames > 0 ? ownerInclusiveBytes : null,
    ownerBytesPerCompletion: matchedOwnerFrames > 0 ? ownerInclusiveBytes / 20000 : null,
  };
  inspector.disconnect();
}
const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceDiff = execFileSync("git", ["-C", sourceRoot, "diff", "HEAD", "--", ownerFile]);
const allRounds = trials.flatMap((trial) => trial.rounds);
const result = {
  node: process.version,
  executable: process.execPath,
  sourceRoot,
  sourceHead,
  ownerFile,
  ownerDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
  scriptSha256: createHash("sha256")
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest("hex"),
  ownerSha256: createHash("sha256")
    .update(await fs.readFile(ownerFile))
    .digest("hex"),
  mode,
  batchSize: 10,
  warmTrials: 2,
  measuredTrials: 20,
  completionsPerTrial: 1000,
  trials,
  allocation,
  aggregate: {
    ownerWallUsPerCompletion:
      (allRounds.reduce((sum, round) => sum + round.ownerWallMs, 0) * 1000) / 20000,
    ownerCpuUsPerCompletion: allRounds.reduce((sum, round) => sum + round.ownerCpuUs, 0) / 20000,
    earlyWallUsPerCompletion:
      (allRounds
        .filter((round) => round.completed === 250)
        .reduce((sum, round) => sum + round.ownerWallMs, 0) *
        1000) /
      5000,
    lateWallUsPerCompletion:
      (allRounds
        .filter((round) => round.completed === 1000)
        .reduce((sum, round) => sum + round.ownerWallMs, 0) *
        1000) /
      5000,
  },
  limits:
    "Actual settlement owner with tiny release callbacks; ten admitted completions per batch. No database commit, full operator/source destructor, or whole-Gateway latency is measured. Traced timing is diagnostic only; CPU includes loop/timer bookkeeping. Sampling includes collection and uses inclusive owner ancestry.",
};
await fs.writeFile(path.join(outputRoot, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
