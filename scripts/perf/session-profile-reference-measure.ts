// Run with node --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../src/config/sessions.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "108" },
    output: { type: "string" },
    golden: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 27,
  fallback: 108,
});
const stateDir = await mkdtemp(path.join(tmpdir(), "session-profile-reference-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const [registry, filters, targets, contexts, selections, work, profiles, database] =
  await Promise.all([
    import("../../src/agents/subagents/registry/subagent-registry-state.js"),
    import("../../src/gateway/session-list-filters.js"),
    import("../../src/gateway/session-list-target.js"),
    import("../../src/gateway/session-row-projection-context.js"),
    import("../../src/gateway/session-row-selection.js"),
    import("../../src/shared/synchronous-work.js"),
    import("../../src/state/user-profile-list.js"),
    import("../../src/state/openclaw-state-db.js"),
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
  const cfg = { agents: { entries: { main: {} } } };
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
  const configuredAgentIds = new Set(["main"]);
  const storePath = path.join(stateDir, "synthetic-sessions");
  const selection = selections.createSessionRowSelection(
    cfg,
    {
      path: storePath,
      paths: new Map([[storePath, 0]]),
      agentId: "main",
      configuredAgentIds,
      ownerAgentIds: configuredAgentIds,
    },
    false,
    () => context,
  );
  const viewerKeys = [new Set<string>(), new Set<string>()];
  const sessionCount = 5_000;
  const now = 10_000_000;
  for (let index = 0; index < sessionCount; index++) {
    const person = index % profileCount;
    const group = Math.floor(person / 25);
    const key = `agent:main:session-${index}`;
    viewerKeys[group]!.add(key);
    const entry: SessionEntry = {
      sessionId: `session-${index}`,
      updatedAt: now - (index + 61) * 1_000,
      createdActor: { type: "human", source: "profile", id: identityId(person) },
      participants: Array.from({ length: 3 }, (_, offset) => ({
        identity: {
          type: "profile",
          id: identityId(group * 25 + ((person + offset) % 25)),
        },
      })),
      ...(index % 3 === 0 ? { archivedAt: 1 } : {}),
    };
    selection.add({
      key,
      entry,
      agentId: "main",
      storeTarget: { agentId: "main", storePath },
      selection: targets.readSessionListSelectionFacts(key, entry),
      generation: Symbol(key),
      hasBoard: false,
    });
  }
  const selected = selection.read("updatedAt");
  const cases: Array<{ name: string; opts: SessionsListParams }> = [
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
  const requests = ["all", "first", "second"].flatMap((viewer, viewerIndex) =>
    cases.map(({ name, opts }) => ({
      name: `${viewer}/${name}`,
      params: {
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
        opts: { archived: "all" as const, includePeople: true, ...opts },
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
  const run = (index: number) =>
    work.runSynchronousWork(filters.filterSessionEntries(requests[index]!.params, page));
  const golden = requests.map(({ name, params }, index) => ({
    name,
    opts: params.opts,
    result: run(index),
  }));
  assert.equal(golden.length, 27);
  assert.equal(golden[3]!.result.involvingProfileId, identityId(43));
  assert.equal(golden[4]!.result.involvingProfileId, identityId(3));
  assert.equal(golden[5]!.result.involvingProfileId, undefined);
  assert.equal(golden[12]!.result.involvingProfileId, undefined);
  assert.equal(golden[21]!.result.involvingProfileId, identityId(43));
  assert.equal(golden[6]!.result.totalCount, 0);
  const warmupOperations = requests.length * 2;
  for (let index = 0; index < warmupOperations; index++) {
    run(index % requests.length);
  }
  inspector.connect();
  await inspector.post("HeapProfiler.collectGarbage");
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const counts = requests.map(() => 0);
  let returnedEntries = 0;
  let matchedEntries = 0;
  const started = process.threadCpuUsage();
  for (let index = 0; index < iterations; index++) {
    const requestIndex = index % requests.length;
    const result = run(requestIndex);
    returnedEntries += result.entries.length;
    matchedEntries += result.totalCount;
    counts[requestIndex]!++;
  }
  const cpu = process.threadCpuUsage(started);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  assert.equal(
    matchedEntries,
    golden.reduce((sum, item, index) => sum + item.result.totalCount * counts[index]!, 0),
  );
  assert.equal(
    returnedEntries,
    golden.reduce((sum, item, index) => sum + item.result.entries.length * counts[index]!, 0),
  );
  assert.equal(existsSync(sqlitePath), false, "measurement must not create profile storage");
  const result = {
    sessionCount,
    profileCount,
    aliases: 10,
    retainedProfiles: 10,
    participantsPerSession: 3,
    warmupOperations,
    operations: iterations,
    requests: requests.map(({ name }, index) => ({ name, operations: counts[index] })),
    returnedEntries,
    matchedEntries,
    cpuMsPerOperation: (cpu.user + cpu.system) / 1_000 / iterations,
    allocationBytesPerOperation: allocatedBytes(profile.head) / iterations,
    samplingInterval: 32_768,
    includesCollectedObjects: true,
  };
  if (values.golden) {
    await writeJson(values.golden, golden);
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
