// Run with node --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../src/config/sessions.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "108" },
    mode: { type: "string", default: "allocation" },
    output: { type: "string" },
    golden: { type: "string" },
    ordinary: { type: "boolean", default: false },
    "team-shape": { type: "boolean", default: false },
    selection: { type: "boolean", default: false },
    "reference-only": { type: "boolean", default: false },
    "heap-profile": { type: "string" },
    "start-at": { type: "string" },
  },
});
assert.ok(values.mode === "timing" || values.mode === "allocation");
const allocations = values.mode === "allocation";
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 27,
  fallback: 108,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "--start-at",
  min: 1,
  fallback: 0,
});
const stateDir = await mkdtemp(path.join(tmpdir(), "session-profile-reference-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const [
  registry,
  filters,
  targets,
  contexts,
  selections,
  profiles,
  database,
  identity,
  sessionLists,
] = await Promise.all([
  import("../../src/agents/subagents/registry/subagent-registry-state.js"),
  import("../../src/gateway/session-list-filters.js"),
  import("../../src/gateway/session-list-target.js"),
  import("../../src/gateway/session-row-projection-context.js"),
  import("../../src/gateway/session-row-selection.js"),
  import("../../src/state/user-profile-list.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/gateway/session-identity-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
]);
const inspector = new Session();
let owner: ReturnType<typeof contexts.createSessionRowProjectionContext> | undefined;
let catalog: Awaited<ReturnType<typeof profiles.prepareUserProfileCatalog>> | undefined;

async function writeJson(filename: string, value: unknown) {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  await writeFile(
    filename,
    `${JSON.stringify(value, (_key, item: unknown) => (item instanceof Map ? [...item] : item), 2)}\n`,
  );
}

function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}

try {
  const subagents = registry.createSubagentSessionListReadView({ env: process.env });
  await subagents.prepare();
  owner = contexts.createSessionRowProjectionContext(subagents);
  // Existing-only admission gives retained identities a real, empty durable fallback.
  catalog = await profiles.prepareUserProfileCatalog();
  const sqlitePath = path.join(stateDir, "state", "openclaw.sqlite");
  assert.equal(existsSync(sqlitePath), false, "preparation must not create profile storage");
  const cfg = { agents: { entries: { main: {}, ...(values.ordinary ? { secondary: {} } : {}) } } };
  const context = owner.current;
  const identities = context.userProfileIdentityById;
  const identityId = (index: number) =>
    `${(index + 1).toString(16).padStart(8, "0")}-1234-4123-8123-123456789abc`;
  const profileCount = 50;
  for (let index = 0; index < profileCount; index++) {
    const canonical = identityId(index >= 30 && index < 40 ? index - 30 : index);
    identities.set(
      identityId(index),
      index >= 40
        ? undefined
        : {
            kind: "resolved",
            profileId: canonical,
            label: `Person ${canonical}`,
            avatarUrl: `/avatar/${canonical}`,
            hasUploadedAvatar: true,
          },
    );
  }
  const configuredAgentIds = new Set(values.ordinary ? ["main", "secondary"] : ["main"]);
  const storePath = path.join(stateDir, "synthetic-sessions");
  const selection = selections.createSessionRowSelection(
    cfg,
    {
      path: storePath,
      paths: new Map([[storePath, 0]]),
      agentId: values.ordinary ? undefined : "main",
      configuredAgentIds,
      ownerAgentIds: configuredAgentIds,
    },
    false,
    () => context,
  );
  const viewerKeys = [new Set<string>(), new Set<string>()];
  const sessionCount = values["team-shape"] ? 10_800 : 5_000;
  const now = 10_000_000;
  const keys: string[] = [];
  for (let index = 0; index < sessionCount; index++) {
    const person = index % profileCount;
    const group = Math.floor(person / 25);
    const agentId = values.ordinary && index % 2 ? "secondary" : "main";
    const kind = values["team-shape"]
      ? index < 4_300
        ? 2
        : index < 9_100
          ? 5
          : index % 25 === 0
            ? 1
            : 0
      : values.ordinary
        ? index % 5
        : 0;
    const key =
      values["team-shape"] && index >= sessionCount - 2
        ? index === sessionCount - 1
          ? "global"
          : "unknown"
        : `agent:${agentId}:${kind === 1 ? "cron:" : kind === 2 ? "subagent:" : kind === 5 ? "dashboard:" : ""}session-${index}`;
    keys.push(key);
    viewerKeys[group]!.add(key);
    const entry: SessionEntry = {
      sessionId: `session-${index}`,
      updatedAt: now - (index + 61) * 1_000,
      createdActor:
        kind === 2 && values["team-shape"]
          ? { type: "agent", id: "main" }
          : { type: "human", source: "profile", id: identityId(person) },
      participants: Array.from({ length: 3 }, (_, offset) => ({
        identity: {
          type: "profile",
          id: identityId(group * 25 + ((person + offset) % 25)),
        },
      })),
      ...((values["team-shape"] ? index >= 4_300 && index < 8_700 : index % 3 === 0)
        ? { archivedAt: 1 }
        : {}),
      ...(values.ordinary ? { label: `Label ${index % 10}` } : {}),
      ...(kind === 3 ? { createdActor: { type: "system" as const, id: "system" } } : {}),
      ...(kind === 4 ? { createdSurface: "plugin-dock" as const } : {}),
    };
    selection.add({
      key,
      entry,
      agentId,
      storeTarget: { agentId, storePath },
      selection: targets.readSessionListSelectionFacts(key, entry),
      generation: Symbol(key),
      hasBoard: false,
    });
  }
  const selected = selection.read("updatedAt");
  const cases: Array<{
    name: string;
    opts: SessionsListParams;
    involvingActorId?: string;
    ownerFirstActorId?: string;
  }> = [
    { name: "canonical-exact", opts: { involvingProfileId: identityId(3) } },
    { name: "alias-exact", opts: { involvingProfileId: identityId(33) } },
    { name: "retained-exact", opts: { involvingProfileId: identityId(43) } },
    { name: "retained-prefix", opts: { involvingProfileId: identityId(43).slice(0, 8) } },
    { name: "alias-prefix", opts: { involvingProfileId: identityId(33).slice(0, 8) } },
    { name: "missing-prefix", opts: { involvingProfileId: "ffffffff" } },
    {
      name: "retained-prefix-empty-window",
      opts: { involvingProfileId: identityId(43).slice(0, 8), activeMinutes: 1 },
    },
    {
      name: "retained-prefix-archived",
      opts: { involvingProfileId: identityId(43).slice(0, 8), archived: true },
    },
    { name: "ordinary-list", opts: {} },
  ];
  if (values["team-shape"]) {
    cases.push(
      { name: "involving-me", opts: { includePeople: false }, involvingActorId: identityId(3) },
      { name: "owner-first", opts: { includePeople: false }, ownerFirstActorId: identityId(3) },
      {
        name: "owner-counts",
        opts: {
          includePeople: false,
          includeOwnerSessionCounts: true,
          includeGlobal: true,
          includeUnknown: true,
        },
      },
    );
  }
  const ordinaryCases: typeof cases = [
    { name: "default", opts: {} },
    { name: "open", opts: { archived: false } },
    { name: "archived", opts: { archived: true } },
    { name: "all", opts: { archived: "all" } },
    { name: "label", opts: { label: "Label 0" } },
    { name: "agent", opts: { agentId: "secondary" } },
    { name: "exclude-cron", opts: { excludeCron: true } },
    { name: "exclude-subagents", opts: { excludeSubagents: true } },
    { name: "exclude-system", opts: { excludeSystem: true } },
    { name: "exclude-dock", opts: { excludeDock: true } },
    // Every session ID matches: dynamic model search requires the real Gateway preparation path.
    { name: "static-search", opts: { search: "session-" } },
  ];
  const requests = (values.ordinary ? ["all"] : ["all", "first", "second"]).flatMap(
    (viewer, viewerIndex) =>
      (values.ordinary ? ordinaryCases : cases).map(({ name, opts, ...actors }) => ({
        name: `${viewer}/${name}`,
        params: {
          ...actors,
          cfg,
          entries: selected.entries,
          entriesSorted: true,
          getTarget: selected.get,
          involvementKeys: selected.involvementKeys,
          getRowContext: () => context,
          userProfileIdentityById: identities,
          configuredAgentIds,
          now,
          restrictProfileReferences: viewerIndex !== 0,
          entryFilter:
            viewerIndex === 0 ? undefined : (key: string) => viewerKeys[viewerIndex - 1]!.has(key),
          opts: {
            ...(values.ordinary ? {} : { archived: "all" as const, includePeople: true }),
            ...opts,
          },
        },
      })),
  );
  for (const { params } of requests) {
    const reference = params.opts.involvingProfileId;
    if (reference && !identities.has(reference)) {
      identities.set(reference, undefined);
    }
  }
  const page = { offset: 0, limit: 25, ownerLimit: 25 };
  const projectOwner = context.identityProjection?.owner ?? identity.projectSessionOwner;
  const projectPeople = context.identityProjection?.people ?? identity.projectSessionPeople;
  const referenceScopes = requests.map(({ params }) => {
    const entries = Array.from(params.entries("all")).filter(
      ([key]) => params.entryFilter?.(key) ?? true,
    );
    const allowed = params.restrictProfileReferences ? new Set<string>() : undefined;
    if (allowed) {
      for (const [, entry] of entries) {
        const actor = projectOwner(entry, identities, cfg, configuredAgentIds)?.actor;
        for (const person of projectPeople(entry, identities, actor)) {
          allowed.add(person.identity.id);
        }
      }
    }
    return { entries, allowed };
  });
  const run = (index: number) => {
    const params = requests[index]!.params;
    if (values["reference-only"]) {
      const scope = referenceScopes[index]!;
      const resolved = params.opts.involvingProfileId
        ? identity.resolveSessionListProfileReference(
            params.opts.involvingProfileId,
            scope.entries,
            identities,
            scope.allowed,
          )
        : undefined;
      if (resolved && !resolved.ok) {
        throw new Error("Unexpected ambiguous benchmark reference");
      }
      return { entries: [], totalCount: 0, involvingProfileId: resolved?.value };
    }
    return values.selection
      ? sessionLists.selectSessionEntries({ ...params, opts: { ...params.opts, limit: 25 } })
      : filters.filterSessionEntries(params, page);
  };
  const capture = () =>
    requests.map(({ name, params }, index) => ({
      name,
      opts: params.opts,
      result: run(index),
    }));
  const golden = capture();
  if (!values.ordinary) {
    assert.equal(golden.length, values["team-shape"] ? 36 : 27);
    assert.equal(golden[3]!.result.involvingProfileId, identityId(43));
    assert.equal(golden[4]!.result.involvingProfileId, identityId(3));
    assert.equal(golden[5]!.result.involvingProfileId, undefined);
    assert.equal(
      golden.find((item) => item.name === "first/retained-prefix")!.result.involvingProfileId,
      undefined,
    );
    assert.equal(
      golden.find((item) => item.name === "second/retained-prefix")!.result.involvingProfileId,
      identityId(43),
    );
    assert.equal(golden[6]!.result.totalCount, 0);
  }
  const warmupOperations = requests.length * 2;
  for (let index = 0; index < warmupOperations; index++) {
    run(index % requests.length);
  }
  inspector.connect();
  await inspector.post("HeapProfiler.collectGarbage");
  if (startAt) {
    const waitMs = startAt - Date.now();
    assert.ok(waitMs > 0, "--start-at must leave enough time for preparation and warmup");
    await delay(waitMs);
  }
  if (allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const counts = requests.map(() => 0);
  const durations = new Float64Array(iterations);
  const gcDurations: number[] = [];
  let measuredUntil = Infinity;
  const measuredSince = performance.now();
  const startedAtEpochMs = Date.now();
  const recordGc = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime >= measuredSince && entry.startTime < measuredUntil) {
        gcDurations.push(entry.duration);
      }
    }
  };
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  let returnedEntries = 0;
  let matchedEntries = 0;
  let updates = 0;
  const started = process.threadCpuUsage();
  for (let index = 0; index < iterations; index++) {
    if (values.ordinary && index % 10 === 0) {
      const key = keys[updates % sessionCount]!;
      const row = selected.get(key)!;
      const entry = { ...row.entry, updatedAt: now + index + 1 };
      selection.add({
        ...row,
        entry,
        selection: targets.readSessionListSelectionFacts(key, entry),
        generation: Symbol(key),
      });
      updates++;
    }
    const requestIndex = index % requests.length;
    const before = performance.now();
    const result = run(requestIndex);
    durations[index] = performance.now() - before;
    returnedEntries += result.entries.length;
    matchedEntries += result.totalCount;
    counts[requestIndex]!++;
  }
  const cpu = process.threadCpuUsage(started);
  measuredUntil = performance.now();
  const profile = allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  await delay(10);
  recordGc(observer.takeRecords());
  observer.disconnect();
  assert.equal(
    matchedEntries,
    golden.reduce((sum, item, index) => sum + item.result.totalCount * counts[index]!, 0),
  );
  assert.equal(
    returnedEntries,
    golden.reduce((sum, item, index) => sum + item.result.entries.length * counts[index]!, 0),
  );
  assert.equal(existsSync(sqlitePath), false, "measurement must not create profile storage");
  durations.sort();
  const result = {
    sessionCount,
    teamShape: values["team-shape"],
    selection: values.selection,
    referenceOnly: values["reference-only"],
    profileCount,
    aliases: 10,
    retainedProfiles: 10,
    participantsPerSession: 3,
    warmupOperations,
    operations: iterations,
    startedAtEpochMs,
    updates,
    durationMs: {
      samples: durations.length,
      p50: durations[Math.floor(iterations * 0.5)],
      p95: durations[Math.floor(iterations * 0.95)],
      p99: durations[Math.floor(iterations * 0.99)],
    },
    gc: {
      collections: gcDurations.length,
      totalMs: gcDurations.reduce((sum, duration) => sum + duration, 0),
      maxMs: Math.max(0, ...gcDurations),
    },
    requests: requests.map(({ name }, index) => ({ name, operations: counts[index] })),
    returnedEntries,
    matchedEntries,
    cpuMsPerOperation: (cpu.user + cpu.system) / 1_000 / iterations,
    mode: values.mode,
    allocationBytesPerOperation: profile ? allocatedBytes(profile.head) / iterations : undefined,
    samplingInterval: allocations ? 32_768 : undefined,
    includesCollectedObjects: allocations ? true : undefined,
  };
  if (values.golden) {
    await writeJson(values.golden, values.ordinary ? { before: golden, after: capture() } : golden);
  }
  if (values["heap-profile"] && profile) {
    await writeJson(values["heap-profile"], profile);
  }
  if (values.output) {
    await writeJson(values.output, result);
  }
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
  owner?.dispose();
  catalog?.release();
  await database.closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
