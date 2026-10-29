/**
 * Real bounded transcript reload with initial model history kept alive.
 * Seed synthetic state with team-shape-stress.ts and transcript-broadcast-measure.ts
 * --seed-history first; never use operator state. Run timing and allocation separately:
 * node --import ./scripts/tsx.mjs scripts/perf/session-reload-measure.ts \
 *   --state-dir .local/synthetic --iterations 2000 --output .local/reload.json
 * Add --allocations for sampled main-isolate allocation (including collected objects).
 * --source-dir selects only SessionManager core/codec from a prepared revision;
 * workers and all other modules use this checkout. Alternate base/candidate runs.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-dir": { type: "string" },
    "session-id": { type: "string", default: "reopen-history-0" },
    "session-key": { type: "string", default: "agent:main:transcript-broadcast-measure-child-0" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name prepared synthetic state");
const stateDir = path.resolve(values["state-dir"]);
assert(
  existsSync(path.join(stateDir, "team-shape-summary.json")),
  "Missing synthetic fixture marker",
);
const storePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
assert(existsSync(storePath), "Missing prepared synthetic database");
if (values.output) {
  assert(!existsSync(values.output), "Refusing to overwrite a result");
}
process.env.OPENCLAW_STATE_DIR = stateDir;
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const sourceRoot = path.resolve(
  values["source-dir"] ?? fileURLToPath(new URL("../../", import.meta.url)),
);
const sources = ["session-manager-core.ts", "session-manager-codec.ts"].map((name) => {
  const file = `src/agents/sessions/${name}`;
  const replacementUrl = pathToFileURL(path.join(sourceRoot, file));
  return {
    file,
    canonicalUrl: new URL(`../../${file}`, import.meta.url).href,
    replacementUrl,
    sha256: hash("sha256", readFileSync(replacementUrl), "hex"),
    loads: 0,
  };
});
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.find((entry) => entry.canonicalUrl === url);
    if (!source) {
      return nextLoad(url, context);
    }
    source.loads++;
    const loaded = nextLoad(source.replacementUrl.href, context);
    return { format: loaded.format, source: loaded.source, shortCircuit: true };
  },
});
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const sessionManagerReadInitialContext: typeof import("../../src/agents/sessions/session-manager-current-turn.js").sessionManagerReadInitialContext =
  (await import("../../src/agents/sessions/session-manager-current-turn.js"))
    .sessionManagerReadInitialContext;
const { closeOpenClawAgentDatabaseByPathAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const target = {
  agentId: "main",
  env: process.env,
  storePath,
  sessionId: values["session-id"],
  sessionKey: values["session-key"],
};
const digest = (value: unknown) => hash("sha256", JSON.stringify(value), "hex");
const inspector = new Session();
inspector.connect();
try {
  const manager = await SessionManager.openBoundedAsync(target, {
    maxEvents: 2000,
    maxBytes: 8 * 1024 * 1024,
  });
  const context = await manager[sessionManagerReadInitialContext]();
  const expectedContext = digest(context);
  const expectedEntries = digest(manager.getEntries());
  const toolTextBytes = context.messages.reduce(
    (bytes, message) =>
      bytes +
      (message.role === "toolResult"
        ? message.content.reduce(
            (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
            0,
          )
        : 0),
    0,
  );
  assert(toolTextBytes >= 32768, "Fixture needs large tool-result text");
  const warmupOperations = 20;
  for (let index = 0; index < warmupOperations; index++) {
    await manager.reloadPersistedTranscriptAsync();
  }
  await inspector.post("HeapProfiler.collectGarbage");
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const gc = new GCProfiler();
  gc.start();
  const processStarted = process.cpuUsage();
  const threadStarted = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await manager.reloadPersistedTranscriptAsync();
  }
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadStarted);
  const processCpu = process.cpuUsage(processStarted);
  const statistics = gc.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const total = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    allocationBytes = total(profile.head);
  }
  assert.equal(digest(context), expectedContext, "Reload changed active model history");
  assert.equal(digest(manager.getEntries()), expectedEntries, "Reload changed transcript entries");
  for (const source of sources) {
    assert(source.loads > 0, `Source hook did not load ${source.file}`);
    assert.equal(
      hash("sha256", readFileSync(source.replacementUrl), "hex"),
      source.sha256,
      `Source changed during measurement: ${source.file}`,
    );
  }
  const byKind = [...new Set(statistics.map((sample) => sample.gcType))].map((kind) => {
    const samples = statistics
      .filter((sample) => sample.gcType === kind)
      .map((sample) => sample.cost / 1000);
    return {
      kind,
      count: samples.length,
      totalMs: samples.reduce((sum, value) => sum + value, 0),
      maxMs: Math.max(0, ...samples),
    };
  });
  const threadCpuMs = (threadCpu.user + threadCpu.system) / 1000;
  const processCpuMs = (processCpu.user + processCpu.system) / 1000;
  const result = {
    scope:
      "Bounded SessionManager reload with live initial context; main-isolate allocation/GC, process CPU includes workers; no Gateway throughput claim",
    node: process.version,
    mode: values.allocations ? "sampled-allocation" : "timing",
    iterations,
    warmupOperations,
    entries: manager.getEntries().length,
    messages: context.messages.length,
    toolTextBytes,
    elapsedMs,
    msPerReload: elapsedMs / iterations,
    threadCpuMs,
    threadCpuMsPerReload: threadCpuMs / iterations,
    processCpuMs,
    processCpuMsPerReload: processCpuMs / iterations,
    allocationBytes,
    allocationBytesPerReload:
      allocationBytes === undefined ? undefined : allocationBytes / iterations,
    gc: {
      count: statistics.length,
      totalMs: byKind.reduce((sum, item) => sum + item.totalMs, 0),
      byKind,
    },
    hostLoadBefore,
    hostLoadAfter,
    memoryBefore,
    memoryAfter,
    contextDigest: expectedContext,
    entriesDigest: expectedEntries,
    sources: sources.map(({ file, sha256, loads }) => ({ file, sha256, loads })),
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    await writeFile(values.output, json, { flag: "wx" });
  }
  console.log(json);
} finally {
  inspector.disconnect();
  await closeOpenClawAgentDatabaseByPathAsync(storePath, target.agentId);
}
