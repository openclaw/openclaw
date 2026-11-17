/**
 * node --import ./scripts/tsx.mjs scripts/perf/session-held-list-measure.ts \
 *   --source-root <checkout> --mode capability --output <SSD-path>/owner.json
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../ui/src/api/types.ts";
import type { SessionGateway } from "../../ui/src/lib/sessions/session-types.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: process.cwd() },
    mode: { type: "string", default: "capability" },
    events: { type: "string", default: "200" },
    output: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
assert(
  values.mode === "capability" || values.mode === "navigation",
  "--mode must be capability or navigation",
);
const sourceRoot = path.resolve(values["source-root"]);
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 100,
  fallback: 200,
});
const files = [
  "session-roster-observations.ts",
  "session-roster-projection.ts",
  "session-row-provenance.ts",
  "index.ts",
  "reconcile.ts",
  "session-reconciliation.ts",
  "navigation.ts",
  "session-key.ts",
  "session-permission-projection.ts",
  "session-deletions.ts",
];
const sourceHash = createHash("sha256");
for (const file of files) {
  sourceHash.update(readFileSync(path.join(sourceRoot, "ui/src/lib/sessions", file)));
}
sourceHash.update(readFileSync(path.join(sourceRoot, "ui/src/api/gateway-session-row-events.ts")));
const gatewayModule: typeof import("../../ui/src/api/gateway.ts") = await import(
  pathToFileURL(path.join(sourceRoot, "ui/src/api/gateway.ts")).href
);
const result = (sessions: GatewaySessionRow[]): SessionsListResult => ({
  ts: 1,
  path: "",
  count: sessions.length,
  sessions,
  defaults: { modelProvider: null, model: null, contextTokens: null },
});
const quantile = (samples: number[], q: number) =>
  samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * q) - 1]!;

async function measureCapability(inventory: number, instrumented: boolean) {
  assert.equal(events % 100, 0, "Capability mode needs --events divisible by 100");
  const {
    GatewaySessionRowEvents,
  }: typeof import("../../ui/src/api/gateway-session-row-events.ts") = await import(
    pathToFileURL(path.join(sourceRoot, "ui/src/api/gateway-session-row-events.ts")).href
  );
  const decoder = new GatewaySessionRowEvents();
  const { createSessionCapability }: typeof import("../../ui/src/lib/sessions/index.ts") =
    await import(pathToFileURL(path.join(sourceRoot, "ui/src/lib/sessions/index.ts")).href);
  const rows: GatewaySessionRow[] = Array.from({ length: inventory }, (_, index) => ({
    key: `agent:main:held-${index}`,
    sessionId: `held-${index}`,
    kind: "direct",
    agentId: "main",
    label: `Synthetic session ${index}`,
    updatedAt: 100_000 - index,
    snapshotAt: 100_000,
    rowMode: "sidebar",
    hasActiveRun: true,
    activeRunIds: [`run-${index}`],
    status: "running",
    unread: false,
    lastReadAt: 1,
  }));
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const client = new gatewayModule.GatewayBrowserClient({ url: "ws://synthetic.invalid" });
  let listReads = 0;
  client.request = async <T>(method: string): Promise<T> => {
    assert.equal(method, "sessions.list");
    listReads++;
    return result(rows.map((row) => ({ ...row }))) as T;
  };
  const gateway: SessionGateway = {
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:held-0",
      assistantAgentId: "main",
      hello: null,
      selfUser: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const sessions = createSessionCapability(gateway, {
    state: { selectedId: "main" },
    subscribe: () => () => undefined,
  });
  const heldQuery = { agentId: "main", limit: inventory, archivedFilter: "all" as const };
  let primaryPublications = 0;
  let heldPublications = 0;
  const stopPrimary = sessions.subscribe(() => primaryPublications++);
  const stopHeld = sessions.subscribeList(heldQuery, () => heldPublications++);
  await sessions.refresh({ agentId: "main", limit: inventory, force: true });
  await sessions.refreshList({ ...heldQuery, force: true });
  assert.equal(sessions.state.result?.sessions.length, inventory);
  assert.equal(sessions.listSnapshot(heldQuery).result?.sessions.length, inventory);

  const frames = Array.from({ length: events + 100 }, (_, index) => {
    const identity = index % 100;
    const row = {
      ...rows[identity]!,
      updatedAt: 200_000 + index,
      snapshotAt: 200_000 + index,
      label: `Synthetic session ${identity} revision ${index}`,
      unread: true,
      permissionMode: null,
      ...(index >= events
        ? { hasActiveRun: false, activeRunIds: [], status: "done" as const }
        : {}),
    };
    const version = Math.floor(index / 100) + 1;
    const { key, agentId } = row;
    const set = {
      updatedAt: row.updatedAt,
      snapshotAt: row.snapshotAt,
      label: row.label,
      unread: row.unread,
      hasActiveRun: row.hasActiveRun,
      activeRunIds: row.activeRunIds,
      status: row.status,
      permissionMode: null,
    };
    return JSON.stringify({
      type: "event",
      event: "sessions.changed",
      payload: {
        reason: "patch",
        sessionKey: row.key,
        agentId: "main",
        session:
          index < 100
            ? { key, agentId, version, full: row }
            : { key, agentId, version, base: version - 1, set, remove: [] },
        ancestorSessions: [],
      },
    });
  });
  const emit = (event: GatewayEventFrame) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  for (const frame of frames.slice(0, 100)) {
    const projected = decoder.project<GatewayEventFrame>(JSON.parse(frame));
    assert.equal(projected.missingBaseline, false);
    emit(projected.event);
  }
  primaryPublications = heldPublications = 0;
  const initialReads = listReads;
  const timing: { decodeMs: number[]; rowDecodeMs: number[]; ownerMs: number[] } = {
    decodeMs: [],
    rowDecodeMs: [],
    ownerMs: [],
  };
  const cpuUs = { decode: 0, rowDecode: 0, owner: 0 };
  const work = { primaryNewRows: 0, heldNewRows: 0 };
  const profiler = values.profile && !instrumented ? new Session() : undefined;
  let profile: Profiler.Profile | undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 100 });
    await profiler.post("Profiler.start");
  }
  const loadBefore = loadavg();
  try {
    for (const frame of frames.slice(100)) {
      const primaryBefore = instrumented ? new Set(sessions.state.result!.sessions) : undefined;
      const heldBefore = instrumented
        ? new Set(sessions.listSnapshot(heldQuery).result!.sessions)
        : undefined;
      let cpu = process.threadCpuUsage();
      let start = performance.now();
      const event: GatewayEventFrame = JSON.parse(frame);
      timing.decodeMs.push(performance.now() - start);
      let used = process.threadCpuUsage(cpu);
      cpuUs.decode += used.user + used.system;
      cpu = process.threadCpuUsage();
      start = performance.now();
      const projected = decoder.project(event);
      timing.rowDecodeMs.push(performance.now() - start);
      used = process.threadCpuUsage(cpu);
      cpuUs.rowDecode += used.user + used.system;
      assert.equal(projected.missingBaseline, false);
      cpu = process.threadCpuUsage();
      start = performance.now();
      emit(projected.event);
      timing.ownerMs.push(performance.now() - start);
      used = process.threadCpuUsage(cpu);
      cpuUs.owner += used.user + used.system;
      if (primaryBefore && heldBefore) {
        for (const row of sessions.state.result!.sessions) {
          work.primaryNewRows += Number(!primaryBefore.has(row));
        }
        for (const row of sessions.listSnapshot(heldQuery).result!.sessions) {
          work.heldNewRows += Number(!heldBefore.has(row));
        }
      }
    }
  } finally {
    if (profiler) {
      profile = (await profiler.post("Profiler.stop")).profile;
      profiler.disconnect();
    }
  }
  const primary = sessions.state.result!;
  const held = sessions.listSnapshot(heldQuery).result!;
  for (const list of [primary, held]) {
    assert.equal(list.sessions.length, inventory);
    for (let identity = 0; identity < 100; identity++) {
      const row = list.sessions.find((value) => value.sessionId === `held-${identity}`);
      assert.equal(row?.label, `Synthetic session ${identity} revision ${events + identity}`);
      assert.equal(row?.status, "done");
      assert.equal(row?.unread, true);
    }
    for (let index = 1; index < list.sessions.length; index++) {
      assert(list.sessions[index - 1]!.updatedAt! >= list.sessions[index]!.updatedAt!);
    }
  }
  assert.equal(listReads, initialReads, "Held-row patches unexpectedly refetched a list");
  const digest = createHash("sha256")
    .update(JSON.stringify([primary, held]))
    .digest("hex");
  stopHeld();
  stopPrimary();
  sessions.dispose();
  return {
    digest,
    primaryPublications,
    heldPublications,
    listReadsDuringEvents: listReads - initialReads,
    ...(instrumented
      ? {
          perEvent: Object.fromEntries(
            Object.entries(work).map(([key, value]) => [key, value / events]),
          ),
        }
      : {
          timing: Object.fromEntries(
            Object.entries(timing).map(([key, samples]) => [
              key,
              { median: quantile(samples, 0.5), p95: quantile(samples, 0.95) },
            ]),
          ),
          threadCpuUsPerEvent: {
            decode: cpuUs.decode / events,
            rowDecode: cpuUs.rowDecode / events,
            owner: cpuUs.owner / events,
          },
          loadBefore,
          loadAfter: loadavg(),
          ...(profile ? { sampledAttribution: summarizeProfile(profile, events) } : {}),
        }),
  };
}

function summarizeProfile(profile: Profiler.Profile, eventCount: number) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parent.set(child, node.id);
    }
  }
  const owners = new Map<string, number>();
  const identityCallers = new Map<string, number>();
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    let id: number | undefined = profile.samples![index];
    const elapsed = profile.timeDeltas?.[index] ?? 0;
    let owner = "runtime / diagnostic / unattributed";
    let identity = false;
    while (id !== undefined) {
      const frame = nodes.get(id)?.callFrame;
      if (frame?.functionName === "resolveUiConversationIdentity") {
        identity = true;
      }
      if (frame?.url.includes("/ui/src/lib/sessions/")) {
        if (owner === "runtime / diagnostic / unattributed") {
          owner = path.basename(frame.url);
        }
        if (
          identity &&
          frame.functionName !== "resolveUiConversationIdentity" &&
          !frame.url.endsWith("session-key.ts")
        ) {
          const caller = `${path.basename(frame.url)}:${frame.functionName || "(anonymous)"}`;
          identityCallers.set(caller, (identityCallers.get(caller) ?? 0) + elapsed);
          identity = false;
        }
      }
      id = parent.get(id);
    }
    owners.set(owner, (owners.get(owner) ?? 0) + elapsed);
  }
  const summarize = (entries: Map<string, number>) =>
    Object.fromEntries(
      [...entries].toSorted((a, b) => b[1] - a[1]).map(([key, us]) => [key, us / eventCount]),
    );
  return {
    meaning:
      "V8 sampled elapsed microseconds per event attributed to nearest session-owner stack frame; not measured exclusive CPU or browser application time",
    nearestOwnerUsPerEvent: summarize(owners),
    conversationIdentityCallerUsPerEvent: summarize(identityCallers),
  };
}
async function measureNavigation(inventory: number, instrumented: boolean) {
  const { resolveSessionNavigation }: typeof import("../../ui/src/lib/sessions/navigation.ts") =
    await import(pathToFileURL(path.join(sourceRoot, "ui/src/lib/sessions/navigation.ts")).href);
  const rows: GatewaySessionRow[] = Array.from({ length: inventory }, (_, index) => ({
    key: `agent:main:held-${index}`,
    sessionId: `held-${index}`,
    kind: "direct",
    updatedAt: inventory - index,
  }));
  let helloReads = 0;
  const input = {
    result: result(rows),
    sessionKey: rows.at(-1)!.key,
    assistantAgentId: "main",
    get hello() {
      if (instrumented) {
        helloReads++;
      }
      return null;
    },
  };
  for (let index = 0; index < 100; index++) {
    resolveSessionNavigation(input);
  }
  helloReads = 0;
  let cpuUs = 0;
  const samples: number[] = [];
  const loadBefore = loadavg();
  let navigation;
  for (let index = 0; index < events; index++) {
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    navigation = resolveSessionNavigation(input);
    samples.push(performance.now() - start);
    const used = process.threadCpuUsage(cpu);
    cpuUs += used.user + used.system;
  }
  assert(navigation);
  assert.equal(navigation.activeRowKey, input.sessionKey);
  assert.equal(navigation.visibleSessions.length, inventory);
  assert.deepEqual(
    navigation.visibleSessions.map((row) => row.key),
    rows.map((row) => row.key),
  );
  return {
    digest: createHash("sha256").update(JSON.stringify(navigation)).digest("hex"),
    ...(instrumented
      ? { perCall: { helloReads: helloReads / events } }
      : {
          medianMs: quantile(samples, 0.5),
          p95Ms: quantile(samples, 0.95),
          threadCpuUsPerCall: cpuUs / events,
          loadBefore,
          loadAfter: loadavg(),
        }),
  };
}

async function measureMode(inventory: number, instrumented: boolean) {
  if (values.mode === "capability") {
    return measureCapability(inventory, instrumented);
  }
  return measureNavigation(inventory, instrumented);
}
const measurements = [];
for (const inventory of [1000, 5000]) {
  const timing = await measureMode(inventory, false);
  const work = await measureMode(inventory, true);
  assert.equal(timing.digest, work.digest, "Instrumentation changed the result");
  measurements.push({
    inventory,
    overlappingWindows: values.mode === "navigation" ? 1 : 2,
    eventIdentities: values.mode === "navigation" ? 1 : 100,
    events,
    timing,
    work,
  });
}
const report = {
  scope:
    values.mode === "capability"
      ? "JSON parse, production GatewaySessionRowEvents delta reconstruction and complete synchronous createSessionCapability gateway event subscribers measured separately, with primary and held all-archive query. List rows are canonical; every full and patch receipt includes permissionMode:null, matching browser load. First100 full rows establish decoder baselines; measured events are versioned patches. Includes normalization, receipts, reconciliation, sorting, permission/mutation/deletion overlays and listener notification; excludes socket, Solid rendering, sidebar and Sessions-page projections, filter/search indexes and timer-driven refresh. Instrumented pass separately counts retained-row reference changes; it does not count sorts or comparisons. Profile samples are diagnostic, not browser acceptance."
      : "resolveSessionNavigation with selected row at tail of held inventory; includes matching, visibility filtering and sorting, but excludes Solid and DOM work. Separate instrumented pass counts hello reads; Node timing is diagnostic, not browser acceptance.",
  mode: values.mode,
  sourceRoot,
  sourceHash: sourceHash.digest("hex"),
  measurements,
};
if (values.output) {
  const output = path.resolve(values.output);
  assert(output.startsWith("/Volumes/Clawstudio-Storage/"), "--output must be on the external SSD");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
