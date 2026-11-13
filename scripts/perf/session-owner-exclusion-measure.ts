/**
 * Session-owner exclusion: real Control UI capability, synthetic list transport.
 * Frozen base/candidate bundle recipe: ./session-owner-exclusion-measure.md.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-owner-exclusion-measure.ts \
 *   --module .local/session-owner-exclusion/base-owner.mjs --iterations 3000 --output .local/base.json
 * Repeat with the candidate module, interleaving five pairs; add --allocations
 * for separate Inspector passes including collected objects (16 KiB sampling).
 * --module must export createSessionCapability; omission uses current source.
 *
 * A 25,000-row synthetic inventory supplies two 200-row windows: a primary roster
 * and another owner's filtered roster. Every operation updates a held nonowner
 * row and advances the existing coordinator six virtual seconds. Warmup and final
 * assertions are excluded. Acceptance: fewer owner-list requests, identical held
 * membership and updated primary facts, lower total CPU/allocation without moving
 * request timing. Report start/end host load; discard pairs above the lane limit.
 *
 * CPU/allocation include the existing synthetic list fixture's selection,
 * projection, serialization accounting and retained request diagnostics. These
 * are client-plus-fixture costs, not database/server/network/render measurements.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayBrowserClient, type GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import type { SessionGateway } from "../../ui/src/lib/sessions/session-types.ts";
import { createTeamScaleSidebarListOwner } from "../../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const modulePath = values.module ? path.resolve(values.module) : undefined;
const {
  createSessionCapability,
}: Pick<typeof import("../../ui/src/lib/sessions/index.ts"), "createSessionCapability"> =
  await import(modulePath ? pathToFileURL(modulePath).href : "../../ui/src/lib/sessions/index.ts");
const measuredSource = modulePath ?? path.resolve("ui/src/lib/sessions/session-list-query.ts");
const initialNow = 1_800_000_000_000;
const actor = (id: string) => ({
  type: "human" as const,
  id,
  identity: { type: "profile" as const, id },
});
const rows: GatewaySessionRow[] = Array.from({ length: 25_000 }, (_, index) => ({
  key: `agent:main:synthetic-${index}`,
  agentId: "main",
  sessionId: `synthetic-${index}`,
  kind: "direct",
  label: `Synthetic session ${index}`,
  updatedAt: initialNow - index,
  snapshotAt: initialNow,
  status: "done",
  hasActiveRun: false,
  archived: index >= 400,
  createdActor: actor(index >= 100 && index < 300 ? "selected" : "other"),
  owner: { actor: actor(index >= 100 && index < 300 ? "selected" : "other") },
}));
const fixture = createTeamScaleSidebarListOwner({
  rows,
  viewerProfileId: "selected",
  now: initialNow,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  owners: [actor("selected"), actor("other")],
});
const listeners = new Set<(event: GatewayEventFrame) => void>();
const calls = { primary: 0, owner: 0 };
const client = new GatewayBrowserClient({ url: "ws://synthetic.invalid" });
mock.getter(client, "recoveryScope", () => "synthetic-owner-scope");
mock.getter(client, "recoveryScopeReady", () => true);
mock.method(client, "request", async (method: string, params: unknown) => {
  if (method === "sessions.subscribe") {
    return { subscribed: true };
  }
  assert.equal(method, "sessions.list");
  assert(isRecord(params));
  calls[params.ownerId ? "owner" : "primary"]++;
  return fixture.list(params).result;
});
const gateway: SessionGateway = {
  snapshot: {
    client,
    phase: "connected",
    sessionKey: rows[0]!.key,
    assistantAgentId: "main",
    hello: null,
    selfUser: null,
  },
  subscribe: () => () => {},
  subscribeEvents(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const query = {
  agentId: "main",
  limit: 200,
  rowMode: "sidebar",
  ownerId: "selected",
  includeDerivedTitles: true,
  includeLastMessage: true,
} as const;
const sessions = createSessionCapability(gateway, {
  state: { selectedId: "main" },
  subscribe: () => () => {},
});
const observation = sessions.observeList(query, () => {});
const inspector = values.allocations ? new Session() : null;
const expectedLabels = new Map<string, string>();
async function settle() {
  for (let turn = 0; turn < 32; turn++) {
    await Promise.resolve();
  }
}
async function deliver(index: number) {
  const original = rows[index % 50]!;
  const row: GatewaySessionRow = {
    ...original,
    updatedAt: Date.now(),
    snapshotAt: Date.now(),
    label: `Synthetic update ${index}`,
    status: index % 2 ? "done" : "running",
    hasActiveRun: index % 2 === 0,
  };
  expectedLabels.set(row.key, row.label!);
  fixture.apply({ upsert: [row] });
  for (const listener of listeners) {
    listener({
      type: "event",
      event: "sessions.changed",
      payload: { agentId: "main", reason: "lifecycle", session: row, ancestorSessions: [] },
    });
  }
  mock.timers.tick(6_000);
  await settle();
}

mock.timers.enable({ apis: ["Date", "setTimeout"], now: initialNow });
try {
  await sessions.refresh({ agentId: "main", limit: 200, force: true });
  await observation.refresh();
  await settle();
  for (let index = 0; index < 100; index++) {
    await deliver(index);
  }
  calls.owner = calls.primary = 0;
  const firstMeasuredRead = fixture.stats().length;
  globalThis.gc?.();
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const startLoad = loadavg();
  const started = process.hrtime.bigint();
  const cpu = process.threadCpuUsage();
  for (let index = 0; index < iterations; index++) {
    await deliver(index + 100);
  }
  const used = process.threadCpuUsage(cpu);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const endLoad = loadavg();
  let sampledAllocatedBytes: number | null = null;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  const primary = sessions.state.result?.sessions ?? [];
  assert.equal(primary.length, 200);
  assert.deepEqual(
    primary.map((row) => row.key).toSorted(),
    rows
      .slice(0, 200)
      .map((row) => row.key)
      .toSorted(),
  );
  assert.deepEqual(
    sessions
      .listSnapshot(query)
      .result?.sessions.map((row) => row.key)
      .toSorted(),
    rows
      .slice(100, 300)
      .map((row) => row.key)
      .toSorted(),
  );
  for (const [key, label] of expectedLabels) {
    assert.equal(primary.find((row) => row.key === key)?.label, label);
  }
  assert.equal(calls.primary, 0, "Known held-row updates must not invalidate the primary roster");
  const result = {
    boundary: "Control UI capability plus synthetic list fixture; no Gateway or renderer",
    mode: values.allocations ? "sampled-allocation" : "untraced-timing",
    module: measuredSource,
    sourceSha256: createHash("sha256").update(readFileSync(measuredSource)).digest("hex"),
    iterations,
    inventoryRows: rows.length,
    heldRowsPerWindow: 200,
    virtualSecondsPerOperation: 6,
    calls,
    ownerCallsPerVirtualMinute: (calls.owner * 10) / iterations,
    serializedFixtureBytes: fixture
      .stats()
      .slice(firstMeasuredRead)
      .reduce((sum, read) => sum + read.bytes, 0),
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs,
    sampledAllocatedBytes,
    startLoad,
    endLoad,
    correctness:
      "Both 200-row windows retain exact membership; every updated primary label is current",
  };
  const output = JSON.stringify(result, null, 2);
  if (values.output) {
    writeFileSync(values.output, output + "\n");
  }
  console.log(output);
} finally {
  inspector?.disconnect();
  observation.dispose();
  sessions.dispose();
  mock.restoreAll();
  mock.timers.reset();
}
