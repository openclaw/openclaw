// Run on an approved benchmark host with synthetic state and --expose-gc --trace-gc-nvp.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
  CodexBindingStateStore,
  StoredCodexAppServerBinding,
} from "../../extensions/codex/src/app-server/session-binding.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SessionCatalogEntrySnapshot } from "../../src/plugins/session-catalog.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    output: { type: "string" },
    operations: { type: "string", default: "4000" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    allocations: { type: "boolean", default: false },
    unchanged: { type: "boolean", default: false },
    "team-shape": { type: "boolean", default: false },
  },
});
const integer = (name: "operations" | "yield-ms" | "start-at", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
assert.ok(global.gc, "Run with --expose-gc");
if (values["team-shape"]) {
  assert.ok(values["state-dir"], "--team-shape requires --state-dir naming a new directory");
}
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : mkdtempSync(path.join(os.tmpdir(), "adoption-candidates-"));
const teamShape = values["team-shape"]
  ? await generateTeamShapeFixture(
      parseTeamShapeOptions(["--state-dir", stateDir, "--transcript-mib", "0"]),
    )
  : undefined;
if (!teamShape) {
  if (values["state-dir"]) {
    mkdirSync(stateDir, { mode: 0o700 });
  }
  for (const directory of ["home", "tmp"]) {
    mkdirSync(path.join(stateDir, directory));
  }
}
const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
const configPath = path.join(stateDir, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const profilePath = path.join(stateDir, "allocation.heapprofile");
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
marker("identify-start");
global.gc();
marker("identify-stop");
// This source-owner harness accepts a sibling baseline module without expanding the plugin API.
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../extensions/codex/src/session-catalog-adoption.ts", import.meta.url);
const owner: typeof import("../../extensions/codex/src/session-catalog-adoption.js") = await import(
  ownerUrl.href
);
const bindingModule: typeof import("../../extensions/codex/src/app-server/session-binding.js") =
  await import(
    new URL("../../extensions/codex/src/app-server/session-binding.ts", import.meta.url).href
  );
const { createPluginRuntime } = await import("../../src/plugins/runtime/index.js");
const runtime = createPluginRuntime();
const storedEntries = teamShape
  ? runtime.agent.session.listSessionEntries({ agentId: "main", readOnly: true })
  : undefined;
const rows = new Map<string, StoredCodexAppServerBinding>();
let bulkReads = 0;
let bindingRows = 0;
const unexpected = (): never => {
  throw new Error("The read-only adoption fixture attempted a mutation or unsupported read");
};
const state: CodexBindingStateStore = {
  lookup: unexpected,
  prepareRead: unexpected,
  prepareGuard: unexpected,
  withCurrent: unexpected,
  asyncReads: {
    lookup: unexpected,
    entries: unexpected,
    lookupMany: async (keys) => {
      bulkReads++;
      bindingRows += keys.length;
      return keys.map((key) => ({ ok: true, value: rows.get(key) }));
    },
  },
};
const bindingStore = bindingModule.createCodexAppServerBindingStore(state);
const sessionCount = 5000;
const adoptionCount = 16;
if (storedEntries) {
  assert.ok(
    storedEntries.length >= sessionCount - adoptionCount,
    "Team fixture has too few stored rows",
  );
}
const entries: ReturnType<NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]>> = [];
const expected = new Map<
  string,
  { key: string; sessionId: string; agentId: string; boundThreadId: string }
>();
for (let index = 0; index < sessionCount; index++) {
  const sessionId = `synthetic-session-${index}`;
  if (index < sessionCount - adoptionCount) {
    entries.push(
      storedEntries
        ? { ...storedEntries[index]!, agentId: "main" }
        : {
            agentId: "main",
            sessionKey: `agent:main:synthetic-${index}`,
            entry: { sessionId, updatedAt: index + 1 },
          },
    );
    continue;
  }
  const threadId = `synthetic-thread-${index}`;
  const sourceHomeId = "synthetic-home";
  const sessionKey = `agent:main:harness:codex:supervision:${hash("sha256", JSON.stringify([sourceHomeId, threadId]), "hex")}`;
  const boundThreadId = `${threadId}-branch`;
  entries.push({
    agentId: "main",
    sessionKey,
    entry: {
      sessionId,
      updatedAt: index + 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: { codex: { supervision: { sourceThreadId: threadId, sourceHomeId } } },
    },
  });
  const identity = bindingModule.sessionBindingIdentity({ sessionId, sessionKey, config: cfg });
  rows.set(bindingModule.bindingStoreKey(identity), {
    version: 1,
    state: "active",
    sessionId,
    binding: {
      threadId: boundThreadId,
      cwd: "/synthetic",
      connectionScope: "supervision",
      supervisionSourceThreadId: threadId,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "synthetic-native-model",
      modelProvider: "openai",
    },
  });
  expected.set(`${sourceHomeId}\0${threadId}`, {
    key: sessionKey,
    sessionId,
    agentId: "main",
    boundThreadId,
  });
}
const expectedJson = JSON.stringify([...expected]);
const entryJson = JSON.stringify(entries);
const sessionEntries: SessionCatalogEntrySnapshot = {
  revision: {},
  entriesForAgent: () => entries,
  entriesForCatalog: () => entries,
};
const list = () =>
  owner.listAdoptedSessionEntries({
    agentId: "main",
    bindingStore,
    config: cfg,
    runtime,
    sessionEntries,
  });
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (p: number) => ({
    samples: count,
    ms: sorted[Math.ceil(count * p) - 1] ?? null,
  });
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
function allocation(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  let ownerBytes = 0;
  let keyParsingBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, owned = false, parsing = false) => {
    const inOwner = owned || node.callFrame.url.includes(ownerUrl.pathname);
    const inParser = parsing || node.callFrame.functionName === "adoptionSessionKeyRest";
    totalBytes += node.selfSize;
    ownerBytes += inOwner ? node.selfSize : 0;
    keyParsingBytes += inParser ? node.selfSize : 0;
    node.children.forEach((child) => visit(child, inOwner, inParser));
  };
  visit(profile.head);
  return {
    totalBytes,
    bytesPerList: totalBytes / operations,
    ownerBytes,
    ownerBytesPerList: ownerBytes / operations,
    keyParsingBytes,
    keyParsingBytesPerList: keyParsingBytes / operations,
  };
}
const inspector = new Session();
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((batch) =>
  recordGcCollections(batch.getEntries(), collections, measuredStart, measuredEnd),
);
const loop = monitorEventLoopDelay({ resolution: 1 });
try {
  for (let index = 0; index < 20; index++) {
    assert.equal(JSON.stringify([...(await list())]), expectedJson);
  }
  global.gc();
  await nextTurn();
  if (values.allocations) {
    inspector.connect();
  }
  loop.enable();
  await delay(10);
  writeSync(1, `ADOPTION_READY ${JSON.stringify({ pid: process.pid, stateDir, startAt })}\n`);
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after setup and warmup");
    await delay(startAt - Date.now());
  }
  const readsBefore = bulkReads;
  const rowsBefore = bindingRows;
  const latency: number[] = [];
  observer.observe({ entryTypes: ["gc"] });
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  loop.reset();
  marker("heap-start");
  measuredStart = performance.now();
  for (let index = 0; index < operations; index++) {
    if (!values.unchanged) {
      sessionEntries.revision = {};
    }
    const started = performance.now();
    const result = await list();
    latency.push(performance.now() - started);
    assert.equal(JSON.stringify([...result]), expectedJson, `Result changed at operation ${index}`);
    await (yieldMs ? delay(yieldMs) : nextTurn());
  }
  measuredEnd = performance.now();
  marker("heap-stop");
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  loop.disable();
  await nextTurn();
  recordGcCollections(observer.takeRecords(), collections, measuredStart, measuredEnd);
  observer.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  if (profile) {
    writeFileSync(profilePath, JSON.stringify(profile));
  }
  assert.equal(bulkReads - readsBefore, operations);
  assert.equal(bindingRows - rowsBefore, operations * adoptionCount);
  assert.equal(JSON.stringify(entries), entryJson, "Listing mutated session metadata");
  const gc = (kind?: number) =>
    distribution(
      collections.filter((item) => kind === undefined || item.kind === kind).map((item) => item.ms),
    );
  const totalGc = gc();
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
    : undefined;
  const result = {
    scope:
      "production adoption owner, real binding store/decoder, in-memory backing adapter; no Gateway, SQLite or native App Server latency claim",
    measurementScope:
      "List latency excludes result verification and pacing; allocation, CPU, GC and elapsed include both. No disk IO occurs during the capture.",
    node: process.version,
    teamShape: teamShape?.summary ?? null,
    storedRowsRead: storedEntries?.length ?? 0,
    owner: ownerUrl.href,
    sessionCount,
    adoptionCount,
    operations,
    yieldMs,
    startAt,
    workload: values.unchanged ? "unchanged-warm-list" : "new-revision-per-list",
    stateDir,
    profilePath: profile ? profilePath : null,
    counts: { bulkReads: bulkReads - readsBefore, bindingRows: bindingRows - rowsBefore },
    golden: {
      entriesSha256: hash("sha256", entryJson, "hex"),
      resultSha256: hash("sha256", expectedJson, "hex"),
      verifiedResults: operations,
      omittedFields: [],
    },
    allocation: profile ? allocation(profile) : null,
    listLatency: distribution(latency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    gc: {
      total: totalGc,
      msPerList: totalGc.totalMs / operations,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: promotion
      ? { ...promotion, bytesPerList: promotion.promotedBytes / operations }
      : null,
    eventLoop: {
      samples: loop.count,
      maxMs: loop.max / 1e6,
      p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
      p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
    },
    memory: { before, after, peakRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024 },
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(values.output ?? path.join(stateDir, "result.json"), output);
  writeSync(1, output);
} finally {
  observer.disconnect();
  loop.disable();
  if (values.allocations) {
    inspector.disconnect();
  }
  if (teamShape) {
    const agentDb = await import("../../src/state/openclaw-agent-db.js");
    const stateDb = await import("../../src/state/openclaw-state-db.js");
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
  }
}
