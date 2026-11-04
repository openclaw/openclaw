/**
 * Replay a synthetic session.entry.read capture from sqlite-reply-census-preload.mjs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-entry-projection-measure.ts \
 *   --reply-file <capture.bin> [--iterations 2000] [--resident-entries 10000] \
 *   [--list-reply-file <actual-projected-worker-reply.bin>] \
 *   [--state-database <stopped-synthetic-gateway-agent.sqlite>]
 * Or use --synthetic instead of --reply-file to prepare both replies through the
 * real entry read worker using one ~30 KiB skills/report fixture (no Gateway boot).
 * Prefer an actual projected reply when available; its complete result must match
 * the full reply with snapshots omitted. Otherwise its wire encoding is reconstructed.
 * Compares full replies with the existing list projection. Five alternating AB/BA
 * timing pairs exclude preparation and forced GC; allocation sampling is separate.
 * Retention measures independently decoded entries from this sample, not the live
 * cache or a claim that every Team session contains the sampled snapshots. SQL,
 * producer encoding, IPC, and application work are outside the measured boundary.
 * Field sizes encode one-field objects independently, so they are not additive.
 * The real replica budgets payloads to 128 entries/8 MiB (one oversized entry
 * excepted), and interns skills. Handles can retain empty cells after eviction.
 * Optional offline census reads stored fields and reports only counts and sizes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  attachSessionEntrySnapshots,
  sessionEntrySnapshotColumnsDefinition,
} from "../../src/config/sessions/session-entry-snapshot-values.js";

const { values } = parseArgs({
  options: {
    "reply-file": { type: "string" },
    synthetic: { type: "boolean", default: false },
    "list-reply-file": { type: "string" },
    iterations: { type: "string", default: "2000" },
    "resident-entries": { type: "string", default: "10000" },
    "state-database": { type: "string" },
  },
});
const iterations = Number(values.iterations);
const residentCount = Number(values["resident-entries"]);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Invalid iterations");
assert(Number.isSafeInteger(residentCount) && residentCount > 0, "Invalid resident count");
assert(
  Boolean(values["reply-file"]) !== values.synthetic,
  "Provide --reply-file from a synthetic Gateway capture or --synthetic",
);
const gc = global.gc;
assert(gc, "Run with --expose-gc");
function census(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const fields = new Map<string, { count: number; valueJsonBytes: number }>();
  const snapshotSessions = new Set<string>();
  let sessions = 0;
  const add = (field: string, valueJson: string) => {
    const total = fields.get(field) ?? { count: 0, valueJsonBytes: 0 };
    total.count++;
    total.valueJsonBytes += Buffer.byteLength(valueJson);
    fields.set(field, total);
  };
  try {
    for (const row of database.prepare("SELECT entry_json FROM session_nodes").iterate()) {
      assert(typeof row.entry_json === "string", "Invalid stored session entry");
      const entry: unknown = JSON.parse(row.entry_json);
      assert(isRecord(entry), "Invalid stored session entry");
      sessions++;
      for (const [field, value] of Object.entries(entry)) {
        add(field, JSON.stringify(value));
      }
    }
    for (const row of database
      .prepare("SELECT session_key, field, value_json FROM session_entry_snapshots")
      .iterate()) {
      assert(
        typeof row.session_key === "string" &&
          typeof row.field === "string" &&
          typeof row.value_json === "string",
        "Invalid stored session snapshot",
      );
      snapshotSessions.add(row.session_key);
      add(row.field, row.value_json);
    }
    return {
      sessions,
      snapshotSessions: snapshotSessions.size,
      fields: [...fields]
        .map(([field, totals]) => ({
          field,
          count: totals.count,
          valueJsonBytes: totals.valueJsonBytes,
        }))
        .toSorted((a, b) => b.valueJsonBytes - a.valueJsonBytes),
    };
  } finally {
    database.close();
  }
}
async function syntheticReplies() {
  const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
  const { resolveOpenClawAgentSqlitePath } =
    await import("../../src/state/openclaw-agent-db.paths.js");
  const { replaceSessionEntrySync } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
  const { withSessionHistoryWorkerDatabase } =
    await import("../../src/config/sessions/session-transcript-worker-runtime.js");
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const sessionKey = "agent:main:projection-measure";
    const scope = { agentId: "main", env, sessionKey };
    const storePath = resolveOpenClawAgentSqlitePath(scope);
    const skills = Array.from({ length: 40 }, (_, index) => ({ name: `synthetic-skill-${index}` }));
    replaceSessionEntrySync(scope, {
      sessionId: "synthetic-session",
      updatedAt: 1,
      lifecycleRevision: "synthetic-lifecycle",
      label: "Synthetic completed task",
      model: "mock-model",
      modelProvider: "mock-provider",
      liveModelSwitchPending: true,
      providerOverride: "mock-provider",
      modelOverride: "mock-next",
      observerDigest: {
        sessionKey,
        runId: "synthetic-run",
        revision: 1,
        updatedAt: 1,
        headline: "Synthetic progress",
        health: "on-track",
      },
      skillsSnapshot: { prompt: "Synthetic skill instructions. ".repeat(800), skills },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 30000, projectContextChars: 0, nonProjectContextChars: 30000 },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 24000,
          entries: skills.map(({ name }) => ({ name, blockChars: 600 })),
        },
        tools: {
          listChars: 2000,
          schemaChars: 4000,
          entries: skills.map(({ name }) => ({ name, summaryChars: 50, schemaChars: 100 })),
        },
      },
      sessionDiffBaseline: {
        version: 1,
        sessionId: "synthetic-session",
        root: "/synthetic",
        files: [],
      },
    });
    return withSessionHistoryWorkerDatabase(
      { agentId: "main", path: storePath, env },
      async (owner) => {
        const read = (snapshotFields?: readonly []) =>
          owner.readExactEntries({
            env,
            sessionKeys: [sessionKey],
            projection: "full",
            snapshotFields,
          });
        return { full: serialize(await read()), list: serialize(await read([])) };
      },
    );
  });
}
const synthetic = values.synthetic ? await syntheticReplies() : undefined;
const captured = synthetic?.full ?? readFileSync(values["reply-file"]!);
const full: unknown = deserialize(captured);
assert(isRecord(full) && Array.isArray(full.entries), "Expected an entry cohort reply");
const rows = full.entries.map((row: unknown) => {
  assert(isRecord(row) && isRecord(row.entry), "Expected a session entry row");
  return { ...row, entry: row.entry };
});
assert(rows.length > 0, "Capture has no entries");
assert(
  rows.some(({ entry }) =>
    sessionEntrySnapshotColumnsDefinition.some(([field]) => entry[field] !== undefined),
  ),
  "Capture has no snapshots; select a populated reply",
);
const listRows = rows.map((row) => ({
  ...row,
  entry: attachSessionEntrySnapshots({ ...row.entry }, {}, "list"),
}));
const expectedList = { ...full, entries: listRows };
const listBytes = values["list-reply-file"]
  ? readFileSync(values["list-reply-file"])
  : (synthetic?.list ?? serialize(expectedList));
const list: unknown = deserialize(listBytes);
assert.deepEqual(list, expectedList, "Projected reply differs beyond the selected snapshots");
assert(isRecord(list) && Array.isArray(list.entries));
const listEntries = list.entries.map((row: unknown) => {
  assert(isRecord(row) && isRecord(row.entry));
  return serialize(row.entry);
});
const fixtures = [
  { name: "full", bytes: captured, entries: rows.map(({ entry }) => serialize(entry)) },
  {
    name: "list",
    bytes: listBytes,
    entries: listEntries,
  },
];
const fieldBytes = new Map<string, { count: number; jsonBytes: number; serializedBytes: number }>();
for (const { entry } of rows) {
  for (const [field, value] of Object.entries(entry)) {
    const total = fieldBytes.get(field) ?? { count: 0, jsonBytes: 0, serializedBytes: 0 };
    total.count++;
    total.jsonBytes += Buffer.byteLength(JSON.stringify({ [field]: value }));
    total.serializedBytes += serialize({ [field]: value }).byteLength;
    fieldBytes.set(field, total);
  }
}
const decoded: { last?: unknown; retained: unknown[] } = { retained: [] };
const decode = (bytes: Uint8Array, count: number) => {
  for (let index = 0; index < count; index++) {
    decoded.last = deserialize(bytes);
  }
};
const timing = [];
for (const fixture of fixtures) {
  decode(fixture.bytes, 100);
}
for (let pair = 0; pair < 5; pair++) {
  for (const fixture of pair % 2 ? fixtures.toReversed() : fixtures) {
    decoded.last = undefined;
    gc();
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    decode(fixture.bytes, iterations);
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    timing.push({
      pair,
      name: fixture.name,
      iterations,
      hostLoad,
      cpuUsPerReply: (used.user + used.system) / iterations,
      elapsedUsPerReply: (elapsedMs * 1000) / iterations,
    });
    assert.deepEqual(decoded.last, fixture.name === "full" ? full : expectedList);
  }
}
const inspector = new Session();
inspector.connect();
const allocations = [];
try {
  for (const fixture of fixtures) {
    decoded.last = undefined;
    gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    decode(fixture.bytes, iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocations.push({
      name: fixture.name,
      iterations,
      sampledBytesPerReply:
        profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
    });
  }
} finally {
  inspector.disconnect();
}
decoded.last = undefined;
const retention = [];
for (const fixture of fixtures) {
  decoded.retained = [];
  gc();
  const before = process.memoryUsage();
  decoded.retained = Array.from({ length: residentCount }, (_, index) =>
    deserialize(fixture.entries[index % fixture.entries.length]!),
  );
  gc();
  const after = process.memoryUsage();
  assert.equal(decoded.retained.length, residentCount);
  assert.deepEqual(decoded.retained[0], deserialize(fixture.entries[0]!));
  retention.push({
    name: fixture.name,
    residentCount,
    retainedHeapBytes: after.heapUsed - before.heapUsed,
    rssBefore: before.rss,
    rssAfter: after.rss,
  });
}
decoded.retained = [];
gc();
console.log(
  JSON.stringify(
    {
      node: process.version,
      scope: "V8 receiver decode and sampled-entry retention model; not Gateway/cache residency",
      replicaContext:
        "Payload budget: 128 entries/8 MiB, with one oversized-entry exception; skills are interned and evicted handles can retain empty cells",
      census: values["state-database"] ? census(values["state-database"]) : undefined,
      captureBytes: captured.byteLength,
      capturedEntries: rows.length,
      listReplySource: synthetic
        ? "synthetic-worker-reply"
        : values["list-reply-file"]
          ? "captured-worker-reply"
          : "reconstructed-projection",
      fields: [...fieldBytes]
        .map(([field, totals]) => ({
          field,
          count: totals.count,
          jsonBytes: totals.jsonBytes,
          serializedBytes: totals.serializedBytes,
        }))
        .toSorted((a, b) => b.serializedBytes - a.serializedBytes),
      replies: fixtures.map(({ name, bytes }) => ({ name, bytes: bytes.byteLength })),
      timing,
      allocations,
      retention,
    },
    null,
    2,
  ),
);
