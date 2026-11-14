/**
 * Owner-boundary proof for discarded tool-event copies and duplicate memory-reader captures.
 * node --import ./scripts/tsx.mjs scripts/perf/gateway-clone-measure.ts --workload tool
 * Use --workload history for queued actor reads; --allocation measures allocation separately.
 * --source-dir points to baseline files saved with their src/gateway-relative paths.
 * --workload sharing measures sharing snapshots across 10k synthetic sessions with
 * 40 plugin tool names. Its --source-dir contains session-accessor.sqlite-entry-cache.types.ts.
 * --workload memory-command or memory-append uses 1,000 incognito sessions with 32 KiB
 * skills metadata. Its --source-dir contains session-actor-memory.ts. --counts counts clones
 * separately from uninstrumented CPU and sampled allocation runs.
 * Accept fewer copies/lower allocation with unchanged isolation; compare CPU in
 * separate untraced passes, alternating baseline/candidate order for five pairs.
 * Run baseline/candidate in alternating order; this is not whole-Gateway stress evidence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SessionActor } from "../../src/config/sessions/session-actor-contract.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "tool" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
    "source-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["tool", "history", "sharing", "memory-command", "memory-append"].includes(values.workload));
assert(!(values.allocation && values.counts), "Measure allocation and clone counts separately");
const memoryCommand = values.workload.startsWith("memory-");
const ownerRoot = new URL(
  values.workload === "sharing" || memoryCommand
    ? "../../src/config/sessions/"
    : "../../src/gateway/",
  import.meta.url,
);
if (values["source-dir"]) {
  const sourceDir = path.resolve(values["source-dir"]);
  const replacements = new Map(
    (values.workload === "sharing"
      ? ["session-accessor.sqlite-entry-cache.types.ts"]
      : memoryCommand
        ? ["session-actor-memory.ts"]
        : ["session-transcript-readers.ts", "worker-environments/live-event-projection.ts"]
    ).map((file) => [new URL(file, ownerRoot).href, path.join(sourceDir, file)]),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      return replacement
        ? {
            format: "module-typescript",
            source: readFileSync(replacement, "utf8"),
            shortCircuit: true,
          }
        : nextLoad(url, context);
    },
  });
}

let run: () => Promise<void>;
let cleanup = () => {};
let operationsPerIteration: number;
if (memoryCommand) {
  const { createMemorySessionActorOwner } =
    await import("../../src/config/sessions/session-actor-memory.js");
  const owner = createMemorySessionActorOwner({ agentId: "synthetic", path: "/synthetic/memory" });
  const authority = { assertCurrent() {}, authorize() {} };
  const actors: SessionActor[] = [];
  const prompt = "Synthetic skills instructions. ".repeat(1093);
  for (let index = 0; index < 1_000; index++) {
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: `agent:synthetic:dashboard:incognito-${index}` },
      { assertCurrent() {}, assertReadable() {} },
    );
    const created = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: `synthetic-${index}`,
            updatedAt: 1,
            incognito: true,
            skillsSnapshot: { prompt, skills: [] },
          },
          transcriptEvents: [
            { type: "session", id: `synthetic-${index}`, version: 3, cwd: "/synthetic" },
          ],
        },
      },
      authority,
    );
    assert.equal(created.kind, "committed");
    actors.push(actor);
  }
  let cursor = 0;
  operationsPerIteration = 1;
  run = async () => {
    const index = cursor++;
    const actor = actors[index % actors.length]!;
    const context = { commandId: `command-${index}`, phaseId: "synthetic-turn" };
    const result =
      values.workload === "memory-append"
        ? await actor.appendTranscriptEvent(
            {
              ...context,
              sessionId: `synthetic-${index % actors.length}`,
              lifecycleRevision: null,
              eventJson: JSON.stringify({
                type: "custom",
                id: `event-${index}`,
                customType: "synthetic",
                data: { text: "Synthetic event payload. ".repeat(128) },
              }),
            },
            authority,
          )
        : await actor.patch(
            { ...context, reducers: [{ kind: "activity", updatedAt: index + 2 }] },
            authority,
          );
    assert.equal(result.kind, "committed");
    if (result.kind === "committed") {
      assert.equal(result.receipt.postimage.entry?.skillsSnapshot?.prompt, prompt);
      if (values.workload === "memory-command") {
        assert.equal(result.receipt.postimage.entry?.updatedAt, index + 2);
      }
    }
  };
  cleanup = () => owner.close();
} else if (values.workload === "sharing") {
  const { projectSessionSharingEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-cache.types.js");
  const entries: InternalSessionEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
    sessionId: `synthetic-${index}`,
    updatedAt: index,
    visibility: "shared",
    archivedAt: index % 10 ? index + 1 : undefined,
    parentSessionKey: "agent:main:dashboard:synthetic",
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: Array.from({ length: 40 }, (_tool, tool) => `plugin-${tool}.read`),
    inheritedToolDeny: ["exec", "write", "browser", "process"],
    owner: { actor: { type: "human", id: `synthetic-owner-${index % 8}` } },
  }));
  let cursor = 0;
  operationsPerIteration = 1;
  run = async () => {
    const entry = entries[cursor++ % entries.length]!;
    const snapshot = projectSessionSharingEntry(entry);
    assert.equal(snapshot.sessionId, entry.sessionId);
    assert.equal(snapshot.inheritedToolAllow?.length, 40);
    assert.notEqual(snapshot.inheritedToolAllow, entry.inheritedToolAllow);
  };
} else if (values.workload === "tool") {
  const { prepareWorkerLiveEventData } =
    await import("../../src/gateway/worker-environments/live-event-projection.js");
  // A search/list result and a tool screenshot exercise payloads common to busy agent turns.
  const result = {
    content: [
      { type: "text", text: "synthetic output ".repeat(1024) },
      { type: "image", data: "YQ==".repeat(16384) },
    ],
    details: {
      rows: Array.from({ length: 100 }, (_, index) => ({
        id: `session-${index}`,
        title: `Synthetic session ${index}`,
        archived: true,
      })),
    },
  };
  const events: WorkerLiveEventParams["event"][] = [
    {
      kind: "tool",
      payload: {
        name: "read",
        toolCallId: "synthetic",
        phase: "start",
        args: { queries: ["synthetic query"], limit: 100 },
      },
    },
    {
      kind: "tool",
      payload: { name: "read", toolCallId: "synthetic", phase: "update", partialResult: result },
    },
    {
      kind: "tool",
      payload: { name: "read", toolCallId: "synthetic", phase: "result", result, isError: false },
    },
  ];
  operationsPerIteration = events.length;
  run = async () => {
    for (const event of events) {
      assert.equal(prepareWorkerLiveEventData(event).name, "read");
    }
  };
} else {
  const [
    { memorySessionActorOwners },
    { runWithSessionActorStorage },
    { resolveIncognitoOpenClawAgentSqlitePath },
    { readSessionActorStorageResult },
    readers,
  ] = await Promise.all([
    import("../../src/config/sessions/session-actor-memory-owner.js"),
    import("../../src/config/sessions/session-actor-storage-binding.js"),
    import("../../src/state/openclaw-agent-db.paths.js"),
    import("../../src/config/sessions/session-actor-storage-result.js"),
    import("../../src/gateway/session-transcript-readers.js"),
  ]);
  const env = { OPENCLAW_STATE_DIR: path.resolve(".local/gateway-clone-measure") };
  const agentId = "synthetic";
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const authority = { assertCurrent() {}, authorize() {} };
  const sessionKey = `agent:${agentId}:dashboard:incognito-measure`;
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const sessionId = "synthetic-session";
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId, updatedAt: 1, incognito: true },
        transcriptEvents: [
          { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
          ...Array.from({ length: 100 }, (_, index) => ({
            type: "message",
            id: `message-${index}`,
            parentId: index ? `message-${index - 1}` : null,
            timestamp: "2026-10-25T00:00:00.000Z",
            message: { role: "user", content: "Synthetic history text" },
          })),
        ],
      },
    },
    authority,
  );
  readSessionActorStorageResult(created);
  const scope = { agentId, sessionId, sessionKey, storePath, env };
  operationsPerIteration = 2;
  run = () =>
    runWithSessionActorStorage({ actor, authority, agentId, path: storePath }, async () => {
      const page = await readers.readSessionMessagesPageWithStatsAsync(scope, {
        offset: 90,
        maxMessages: 10,
      });
      const exact = await readers.readSessionMessageByIdAsync(scope, "message-99", {
        currentOnly: true,
        maxBytes: 16384,
      });
      assert.equal(page.messages.length, 10);
      assert.equal(exact.found, true);
    });
  cleanup = () => memorySessionActorOwners.reset();
}
for (let index = 0; index < 200; index++) {
  await run();
}
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const diagnostics = startGatewayBenchDiagnostics();
const hostLoad = loadavg();
const before = process.memoryUsage();
let cloneCalls = 0;
const clone = globalThis.structuredClone;
if (values.counts) {
  globalThis.structuredClone = function <T>(value: T, options?: StructuredSerializeOptions): T {
    cloneCalls++;
    return clone(value, options);
  };
}
const cpuBefore = process.threadCpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  await run();
  if (index % 32 === 31) {
    await setImmediate();
  }
}
const wallMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuBefore);
globalThis.structuredClone = clone;
await setImmediate();
const metrics = diagnostics();
let sampledBytes: number | undefined;
let allocationSamples: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  allocationSamples = profile.samples.length;
  inspector.disconnect();
}
const operations = iterations * operationsPerIteration;
console.log(
  JSON.stringify({
    workload: values.workload,
    source: values["source-dir"] ? "baseline" : "candidate",
    node: process.version,
    ownerRoot: fileURLToPath(ownerRoot),
    iterations,
    operations,
    allocation: values.allocation,
    cloneCallsPerOperation: values.counts ? cloneCalls / operations : undefined,
    wallMs,
    cpuUsPerOperation: (cpu.user + cpu.system) / operations,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / operations,
    allocationSamples,
    hostLoad,
    memory: { before, after: process.memoryUsage() },
    diagnostics: metrics,
  }),
);
cleanup();
