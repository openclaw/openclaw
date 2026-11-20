// Measure two discovery bursts, idle recovery, and the next request with production GC.
// Run with Node 24.22.1 and empty NODE_OPTIONS:
// node scripts/perf/discovery-worker-idle-measure.mjs --build-dir BUILD --state-dir NEW --output NEW.json
// Fixture and exact scan oracle follow worker-module-graphs-measure.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    "build-dir": { type: "string" },
    "state-dir": { type: "string" },
    output: { type: "string" },
  },
});
assert(values["build-dir"] && values["state-dir"] && values.output);
assert.equal(process.version, "v24.22.1");
assert.deepEqual(process.execArgv, []);
assert.equal(process.env.NODE_OPTIONS ?? "", "");
const skillCount = 100;
const pluginCount = 100;
const scansPerBurst = 101;
const idleMs = 5_000;
const state = path.resolve(values["state-dir"]);
const entry = path.resolve(values["build-dir"], "dist/skills/runtime/discovery.worker.js");
assert((await fs.stat(entry)).isFile());
const entrySha256 = createHash("sha256")
  .update(await fs.readFile(entry))
  .digest("hex");
await fs.mkdir(state);
for (const name of ["home", "state"]) {
  await fs.mkdir(path.join(state, name));
}
const environment = {
  HOME: path.join(state, "home"),
  OPENCLAW_HOME: path.join(state, "home"),
  OPENCLAW_STATE_DIR: path.join(state, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(state, "absent"),
};
function skillContent(name) {
  return `---\nname: ${name}\ndescription: Synthetic skill ${name}\n---\nSynthetic instructions.\n`;
}
async function writeSkill(directory, name) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), skillContent(name));
}
const pluginContributions = [];
for (let index = 0; index < pluginCount; index++) {
  const rootDir = path.join(state, `contribution-${index}`);
  await writeSkill(path.join(rootDir, "skills", `plugin-skill-${index}`), `plugin-skill-${index}`);
  pluginContributions.push({
    id: `provider-${index}`,
    origin: "bundled",
    rootDir,
    roots: ["skills"],
  });
}
const requests = [];
for (let workspace = 0; workspace < 4; workspace++) {
  const directory = path.join(state, `workspace-${workspace}`);
  const skills = path.join(directory, "skills");
  for (let index = 0; index < skillCount; index++) {
    await writeSkill(path.join(skills, `skill-${index}`), `skill-${index}`);
  }
  requests.push({
    key: directory,
    environment,
    selection: {
      kind: "planned",
      plan: {
        input: {
          workspaceDir: directory,
          environment,
          acpRuntimeAvailable: false,
          pluginContributions,
          options: {
            managedSkillsDir: path.join(state, "managed"),
            bundledSkillsDir: path.join(state, "absent"),
          },
        },
      },
      request: {
        limits: {
          maxCandidatesPerRoot: 100,
          maxSkillsLoadedPerSource: 100,
          // Match DEFAULT_MAX_SKILL_FILE_BYTES in skill-root-discovery.ts.
          maxSkillFileBytes: 256_000,
        },
        additionalBins: [],
      },
    },
  });
}
const expectedNames = [
  ...Array.from({ length: skillCount }, (_, index) => `skill-${index}`),
  ...Array.from({ length: pluginCount }, (_, index) => `plugin-skill-${index}`),
].toSorted();
const pluginSkillsDir = path.join(environment.OPENCLAW_STATE_DIR, "plugin-skills");
function expectedRecord(name, baseDir, source, discoveryRoot, syncSourceDir, syncDirName) {
  return JSON.stringify([
    name,
    `Synthetic skill ${name}`,
    createHash("sha256").update(skillContent(name)).digest("hex"),
    source,
    baseDir,
    path.join(baseDir, "SKILL.md"),
    discoveryRoot,
    syncSourceDir,
    syncDirName,
  ]);
}
// Raw discovery retains direct roots and generated links for collision diagnostics.
// Build the exact multiset before timing; effective names still occur only once.
const expectedRecords = new Map(
  requests.map(({ key }) => [
    key,
    [
      ...Array.from({ length: skillCount }, (_, index) => {
        const name = `skill-${index}`;
        const root = path.join(key, "skills");
        return expectedRecord(name, path.join(root, name), "openclaw-workspace", root);
      }),
      ...Array.from({ length: pluginCount }, (_, index) => {
        const name = `plugin-skill-${index}`;
        const root = path.join(state, `contribution-${index}`, "skills");
        const sourceDir = path.join(root, name);
        return [
          expectedRecord(name, sourceDir, "openclaw-extra", root),
          expectedRecord(
            name,
            path.join(pluginSkillsDir, name),
            "openclaw-extra",
            pluginSkillsDir,
            sourceDir,
            name,
          ),
        ];
      }).flat(),
    ].toSorted(),
  ]),
);
function verify(reply) {
  assert.equal(reply.kind, "scan");
  assert.equal(reply.results.length, 4);
  assert.deepEqual(
    reply.results.map((result) => result.key),
    requests.map((request) => request.key),
  );
  for (const result of reply.results) {
    assert.equal(result.plan.pluginSkillsDir, pluginSkillsDir);
    assert.deepEqual(result.sources.executionEntries, []);
    assert.deepEqual(
      result.sources.entries
        .map(({ skill, syncSourceDir, syncDirName }) =>
          JSON.stringify([
            skill.name,
            skill.description,
            skill.contentHash,
            skill.source,
            skill.baseDir,
            skill.filePath,
            skill.discoveryRoot?.path,
            syncSourceDir,
            syncDirName,
          ]),
        )
        .toSorted(),
      expectedRecords.get(result.key),
    );
    assert.deepEqual(
      [...new Set(result.sources.entries.map((skillEntry) => skillEntry.skill.name))].toSorted(
        (left, right) => (left < right ? -1 : left > right ? 1 : 0),
      ),
      expectedNames,
    );
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  }
}
const request = { kind: "scan", path: process.env.PATH, requests };
function startClock() {
  return { process: process.cpuUsage(), main: process.threadCpuUsage(), at: performance.now() };
}
function stopClock(start) {
  const elapsedMs = performance.now() - start.at;
  const processCpu = process.cpuUsage(start.process);
  const mainCpu = process.threadCpuUsage(start.main);
  return {
    elapsedMs,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
  };
}
let peakRssBytes = 0;
let rssSamples = 0;
let previousRssAt;
let maximumRssGapMs = 0;
function sampleRss() {
  const now = performance.now();
  if (previousRssAt !== undefined) {
    maximumRssGapMs = Math.max(maximumRssGapMs, now - previousRssAt);
  }
  previousRssAt = now;
  const rss = process.memoryUsage.rss();
  peakRssBytes = Math.max(peakRssBytes, rss);
  rssSamples++;
  return rss;
}
const report = {
  complete: false,
  runtime: process.version,
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS ?? "",
  entrySha256,
  fixture: { workspaces: 4, skillCount, pluginCount, scansPerBurst, bursts: 2, idleMs },
  hostLoadBefore: os.loadavg(),
  bursts: [],
  resumptions: [],
  limitations: [
    "Whole component-process RSS and CPU include the parent and worker; not Gateway RSS.",
    "No observer forces GC or enables GCProfiler; production idle GC remains enabled.",
    "Boundary samples use the production memory port, including V8 heap-space counters.",
    "Worker samples have parent send/receive bounds, not an atomic process-wide timestamp.",
    "Five seconds idle does not prove GC completion; no GC events are observed.",
    "RSS is sampled every 20ms plus endpoints and can miss transient peaks.",
    "Per-scan clocks exclude verification; burst and end-to-end clocks include it.",
    "Idle cost includes the after-burst sample; resumption includes after-idle sampling.",
    "The controller owns removal of the exclusive state directory after child exit.",
    "After measured work settles, the owner explicitly terminates and joins its worker.",
  ],
};
const tasks = new MessageChannel();
const ready = Promise.withResolvers();
let pending;
let pendingMemory;
let memoryPort;
let initialMemory;
let memorySequence = 0;
let auxiliaryMessages = 0;
let taskId = 0;
let fatal = /** @type {Error | undefined} */ (undefined);
let stopping = false;
let exitCode;
let worker;
let resumption;
function fail(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  fatal ??= failure;
  ready.reject(failure);
  pending?.reject(failure);
  pendingMemory?.reject(failure);
}
function receiveMemory(packet) {
  try {
    if ("heapTotal" in packet) {
      assert(Number.isFinite(packet.heapUsed) && packet.heapUsed >= 0);
      assert(Number.isFinite(packet.heapTotal) && packet.heapTotal >= packet.heapUsed);
      assert.equal(packet.gc, undefined);
      const value = { sequence: ++memorySequence, receivedAt: performance.now(), counters: packet };
      if (!initialMemory) {
        initialMemory = value;
      } else {
        assert(pendingMemory, "Unsolicited worker memory sample");
      }
      pendingMemory?.resolve(value);
    } else {
      assert(
        "sqliteReaderCounter" in packet || "postgresBridgeCounters" in packet,
        "Unexpected worker memory message",
      );
      auxiliaryMessages++;
    }
  } catch (error) {
    fail(error);
  }
}
async function readWorkerMemory() {
  assert(memoryPort, "Missing worker memory port");
  async function waitForSample(requestSample) {
    if (fatal) {
      throw fatal;
    }
    assert.equal(pendingMemory, undefined);
    pendingMemory = Promise.withResolvers();
    const sentAt = performance.now();
    const timeout = setTimeout(() => fail(new Error("Worker memory sample timed out")), 10_000);
    try {
      if (requestSample) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no Window target origin.
        memoryPort.postMessage(undefined);
      }
      return { sentAt, ...(await pendingMemory.promise) };
    } finally {
      clearTimeout(timeout);
      pendingMemory = undefined;
    }
  }
  if (!initialMemory) {
    await waitForSample(false);
  }
  return await waitForSample(true);
}
const beforeWorkerRssBytes = sampleRss();
const sampler = setInterval(sampleRss, 20);
const endToEnd = startClock();
const startup = startClock();
try {
  worker = new Worker(pathToFileURL(entry), {
    execArgv: [],
    env: { ...process.env, ...environment },
  });
  report.resourceLimits = worker.resourceLimits;
  report.threadId = worker.threadId;
  worker.on("error", fail);
  worker.on("exit", (code) => {
    exitCode = code;
    if (!stopping) {
      fail(new Error(`Worker exited before owner shutdown: ${code}`));
    }
  });
  tasks.port1.on("message", (message) => {
    try {
      if (message.status === "ready") {
        ready.resolve();
        return;
      }
      if (message.status === "memory") {
        assert.equal(memoryPort, undefined);
        memoryPort = message.port;
        memoryPort.on("message", receiveMemory);
        memoryPort.on("messageerror", fail);
        return;
      }
      assert(pending && message.taskId === taskId, "Unexpected discovery task identity");
      if (message.status === "ok") {
        pending.resolve(message.value);
      } else if (message.status === "failed") {
        fail(new Error(message.error));
      } else {
        assert.equal(message.status, "consumed");
      }
    } catch (error) {
      fail(error);
    }
  });
  tasks.port1.on("messageerror", fail);
  worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [tasks.port2]);
  const readyTimeout = setTimeout(() => fail(new Error("Discovery startup timed out")), 120_000);
  try {
    await ready.promise;
  } finally {
    clearTimeout(readyTimeout);
  }
  report.startup = stopClock(startup);
  report.beforeWorkerRssBytes = beforeWorkerRssBytes;
  report.readyRssBytes = sampleRss();
  async function runScan() {
    if (fatal) {
      throw fatal;
    }
    pending = Promise.withResolvers();
    const timeout = setTimeout(() => fail(new Error("Discovery scan timed out")), 120_000);
    const clock = startClock();
    try {
      tasks.port1.postMessage({
        taskId: ++taskId,
        input: request,
        interactive: true,
        sampleMemory: taskId === 1,
        nativeSections: new SharedArrayBuffer(4),
        taskContext: { deletedAgentDatabaseFences: [], collectWorkerMetrics: false },
      });
      const reply = await pending.promise;
      const timing = stopClock(clock);
      if (resumption) {
        report.resumptions.push(stopClock(resumption));
        resumption = undefined;
      }
      verify(reply);
      return timing;
    } finally {
      clearTimeout(timeout);
      pending = undefined;
    }
  }
  for (let burst = 0; burst < 2; burst++) {
    const scans = [];
    const burstClock = startClock();
    for (let index = 0; index < scansPerBurst; index++) {
      scans.push(await runScan());
    }
    const total = stopClock(burstClock);
    const idleClock = startClock();
    const afterBurstRssBytes = sampleRss();
    const afterBurstMemory = await readWorkerMemory();
    const idleTimerStartedAt = performance.now();
    await delay(idleMs);
    const idleTimerWokeAt = performance.now();
    const idle = stopClock(idleClock);
    resumption = startClock();
    const afterIdleRssBytes = sampleRss();
    const afterIdleMemory = await readWorkerMemory();
    report.bursts.push({
      scans,
      total,
      afterBurstRssBytes,
      afterBurstMemory,
      idle,
      idleTimerStartedAt,
      idleTimerWokeAt,
      afterIdleRssBytes,
      afterIdleMemory,
    });
  }
  report.nextScan = await runScan();
  report.endToEnd = stopClock(endToEnd);
  report.afterNextScanRssBytes = sampleRss();
  report.peakRssBytes = peakRssBytes;
  report.rssSampling = { intervalMs: 20, samples: rssSamples, maximumGapMs: maximumRssGapMs };
  report.initialMemory = initialMemory;
  report.memorySequence = memorySequence;
  report.auxiliaryMessages = auxiliaryMessages;
  report.completedScans = taskId;
  report.hostLoadAfter = os.loadavg();
  assert.equal(memorySequence, 5);
  assert.equal(report.resumptions.length, 2);
  if (fatal) {
    throw fatal;
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  stopping = true;
  try {
    memoryPort?.close();
    tasks.port1.close();
    tasks.port2.close();
    if (worker) {
      // An already-exited worker returns no value; its exit event owns the code.
      report.termination = { requested: true, code: (await worker.terminate()) ?? exitCode };
      assert.equal(typeof report.termination.code, "number");
      assert.equal(exitCode, report.termination.code);
    }
  } catch (error) {
    report.cleanupError = String(error?.stack ?? error);
    report.error ??= String(fatal?.stack ?? fatal ?? report.cleanupError);
    process.exitCode = 1;
  }
}
if (fatal && !report.error) {
  report.error = String(fatal?.stack ?? fatal);
  process.exitCode = 1;
}
report.complete =
  !report.error && report.completedScans === 2 * scansPerBurst + 1 && report.bursts.length === 2;
await fs.writeFile(path.resolve(values.output), `${JSON.stringify(report)}\n`, { flag: "wx" });
console.log(JSON.stringify({ complete: report.complete, scans: report.completedScans }));
