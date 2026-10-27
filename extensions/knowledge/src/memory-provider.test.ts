import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { memoryFixture } from "./memory-provider.test-support.js";
import type { Recall } from "./model.js";
import type { RecallInput } from "./mutation-contract.js";
import type { Stores } from "./stores.js";
import { afterTest, useTestTempDirs, defaultOrder } from "./test-support.js";

const tempDirs = useTestTempDirs();

it("shared search/get/health roundtrip uses native publication, provenance and revision refs", async () => {
  const f = await memoryFixture(tempDirs);
  const saved = await f.save(
    "Orchid decision",
    "Choose SQLite\nBecause local persistence matters.",
  );
  const { provider } = await f.open();
  expect(provider.capabilities).toStrictEqual({
    sources: ["memory"],
    pagination: true,
    candidates: ["trigger", "project"],
    projectFilter: false,
  });
  const result = await provider.search({ query: "Orchid" });
  expect(result.hits.length).toBe(1);
  const hit = result.hits[0];
  expect(hit.reference).toStrictEqual({
    providerId: "knowledge",
    id: saved.id,
    revision: `${saved.revision}:${saved.hash}@${f.vaultId}`,
  });
  expect(hit.automaticRecall.eligible).toBe(false);
  expect(hit.path).toBe(undefined);
  const first = await provider.get({ reference: hit.reference, lines: 2 });
  const rest = await provider.get({ reference: hit.reference, from: first.nextFrom, lines: 200 });
  expect(first.text).toMatch(/Orchid decision/);
  expect(rest.text).toMatch(/Choose SQLite/);
  expect(rest.truncated).toBe(false);
  expect(first.citations[0].reference.id).toBe(saved.id);
  expect((await provider.health()).status).toBe("ready");
  await provider.close();
  await provider.close();
  await expect(provider.search({ query: "Orchid" })).rejects.toThrow(/closed/);
  expect((await f.service.record({ id: saved.id }, f.tool)).record!.id).toBe(saved.id);
});

it("conversation audiences never acquire private scope", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private sentinel");
  f.setAudience(f.conversation);
  await f.save("Conversation sentinel");
  const { provider } = await f.open();
  const group = await provider.search({ query: "sentinel" });
  expect(group.hits.length).toBe(1);
  expect(group.hits[0].excerpt).toMatch(/Conversation/);
  expect(JSON.stringify(await provider.health())).not.toMatch(/Private/);
  f.setAudience({ kind: "owner-private", agentId: "main" });
  await expect(provider.search({ query: "sentinel" })).rejects.toThrow(/authority/);
  const nonowner = await f.open({
    ...f.context,
    authority: { ...f.context.authority, audience: f.conversation },
  });
  expect((await nonowner.provider.search({ query: "Private" })).hits.length).toBe(0);
});

it("operator authorization and missing, foreign, host, and sandbox audience rejection", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private note");
  const operator = {
    ...f.context,
    authority: { kind: "operator", connId: "real-connection", scopes: ["operator.read"] },
  };
  const operatorProvider = (await f.open(operator)).provider;
  expect((await operatorProvider.search({ query: "Private" })).hits.length).toBe(1);
  await expect(operatorProvider.candidates({ kind: "trigger" })).rejects.toThrow(/owner-private/);
  for (const authority of [
    { kind: "operator", scopes: ["operator.read"] },
    { kind: "operator", connId: "x", scopes: [] },
    { kind: "host", operation: "bootstrap" },
    { ...f.context.authority, sandboxed: true },
    { ...f.context.authority, audience: undefined },
    { ...f.context.authority, audience: { kind: "owner-private", agentId: "other" } },
  ]) {
    await expect(f.open({ ...f.context, authority })).rejects.toThrow(/authority|memory audience/);
  }
  await expect(f.open(f.context, "other")).rejects.toThrow(/authority/);
  await expect(f.open({ ...f.context, assertCurrent: undefined })).rejects.toThrow(/authority/);
  const restricted = await memoryFixture(tempDirs, { operatorRead: false });
  await expect(restricted.open(operator)).rejects.toThrow(/authority/);
});

it("host status receives health only and every other host purpose is denied", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private status sentinel");
  const host = { ...f.context, authority: { kind: "host", operation: "status" } };
  const { provider } = await f.open(host, "main", "status");
  expect(await provider.health()).toStrictEqual({
    status: "ready",
    message: "Knowledge vault readiness check.",
  });
  await expect(provider.search({ query: "sentinel" })).rejects.toThrow(/authority/);
  await expect(
    provider.get({ reference: { providerId: "knowledge", id: "recordid" } }),
  ).rejects.toThrow(/authority/);
  await expect(provider.candidates({ kind: "trigger" })).rejects.toThrow(/authority/);
  await provider.close();
  await expect(provider.health()).rejects.toThrow(/closed/);
  for (const purpose of [undefined, "default", "cli"]) {
    await expect(f.open(host, "main", purpose)).rejects.toThrow(/authority/);
  }
});

// Storage runs in a worker, so these drive the provider over a stub storage client
// (only the Stores members the provider uses): its own fencing must hold.
async function stubProvider(
  call: (op: string) => unknown,
  authority: any,
  purpose?: "default" | "status" | "cli",
) {
  const { createKnowledgeMemoryRuntime } = await import("./memory-provider.js");
  const caller = { active: true };
  const runtime = {
    vaultId: randomUUID(),
    client: { call: async (op: string) => call(op) },
    enqueue: (check: any, operation: any) => {
      check();
      return operation();
    },
  };
  const stores = {
    policy: { operatorRead: false },
    incarnation: 0,
    assertLive(_epoch: number) {},
    async open(principal: any, _options: { provision: boolean }): Promise<unknown> {
      const access = { ...principal(), assertCurrent: () => principal() };
      return { kind: "ready", runtime, access };
    },
  };
  const context: any = {
    authority,
    assertCurrent() {
      if (!caller.active) {
        throw new Error("caller revoked");
      }
    },
  };
  const { provider } = await createKnowledgeMemoryRuntime(stores as Stores).open({
    cfg: {},
    agentId: "main",
    context,
    ...(purpose ? { purpose } : {}),
  });
  return { provider: provider!, caller };
}

it("host readiness redacts all states and storage errors while preserving lease fences", async () => {
  let facts = { ontology: true, issues: 0, records: 42 },
    failure: any = undefined;
  const { provider, caller } = await stubProvider(
    (op) => {
      expect(op).toBe("memoryHealth");
      if (failure) {
        throw failure;
      }
      return facts;
    },
    { kind: "host", operation: "status" },
    "status",
  );
  for (const [ontology, issues, status] of [
    [true, 0, "ready"],
    [true, 1, "degraded"],
    [false, 0, "unavailable"],
  ] as const) {
    facts = { ontology, issues, records: 42 };
    expect(await provider.health()).toStrictEqual({
      status,
      message: "Knowledge vault readiness check.",
    });
  }
  failure = new Error("Failed private/secret-record.md in vault-id partition-id");
  expect(await provider.health()).toStrictEqual({
    status: "unavailable",
    message: "Knowledge vault readiness unavailable.",
  });
  caller.active = false;
  await expect(provider.health()).rejects.toThrow(/caller revoked/);
  await provider.close();
});

it("index failure is not empty success and late backend results are fenced", async () => {
  let reply: any;
  const { provider, caller } = await stubProvider(
    (op) => {
      expect(op).toBe("search");
      return reply();
    },
    {
      kind: "session",
      sessionKey: "agent:main:test",
      sessionId: randomUUID(),
      sandboxed: false,
      audience: { kind: "owner-private", agentId: "main" },
    },
  );
  reply = () => ({ index: { state: "unavailable", message: "Index unavailable; retry" } });
  await expect(provider.search({ query: "Orchid" })).rejects.toThrow(/Index unavailable/);
  reply = () => {
    caller.active = false;
    return {
      index: { state: "ready", snapshot: "s", message: "" },
      hits: [],
      total: 0,
      nextOffset: null,
      coverage: { complete: true, message: "" },
    };
  };
  await expect(provider.search({ query: "Orchid" })).rejects.toThrow(/revoked/);
});

it("queued result release revalidates authority, cancellation and service incarnation", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Orchid note");
  const { provider } = await f.open();
  const pending = provider.search({ query: "Orchid" });
  f.revoke();
  await expect(pending).rejects.toThrow(/revoked/);
  await provider.close();
  const g = await memoryFixture(tempDirs),
    controller = new AbortController();
  const lease = (await g.open({ ...g.context, signal: controller.signal })).provider;
  controller.abort();
  await expect(lease.health()).rejects.toThrow();
  await lease.close();
  const old = (await g.open()).provider;
  const lifecycle = g.services.find((s: any) => s.id === "knowledge:live-state");
  lifecycle.stop();
  lifecycle.start();
  afterTest(() => lifecycle.stop());
  await expect(old.health()).rejects.toThrow(/reloaded/);
});

it("cursor preserves query/scope/snapshot and revision fences reject stale reads", async () => {
  const f = await memoryFixture(tempDirs);
  const saved = await f.save("Orchid one");
  await f.save("Orchid two");
  const { provider } = await f.open();
  const page = await provider.search({ query: "Orchid", maxResults: 1 });
  expect(page.coverage).toBe("partial");
  expect(page.nextCursor).toBeTruthy();
  const next = await provider.search({ query: "Orchid", maxResults: 1, cursor: page.nextCursor });
  expect(next.hits[0].reference.id).not.toBe(page.hits[0].reference.id);
  await expect(provider.search({ query: "different", cursor: page.nextCursor })).rejects.toThrow(
    /cursor/,
  );
  await f.service.save_page(
    {
      ...f.fence(saved),
      expectedVaultId: f.vaultId,
      type: "note",
      title: "Orchid one",
      body: "Changed",
    },
    f.tool,
  );
  await expect(provider.search({ query: "Orchid", cursor: page.nextCursor })).rejects.toThrow(
    /snapshot changed/,
  );
  await expect(
    provider.get({
      reference: {
        providerId: "knowledge",
        id: saved.id,
        revision: `${saved.revision}:${saved.hash}@${f.vaultId}`,
      },
    }),
  ).rejects.toThrow(/changed/);
  // A reference minted by another store never resolves here.
  await expect(
    provider.get({
      reference: {
        providerId: "knowledge",
        id: saved.id,
        revision: `${saved.revision}:${saved.hash}@${randomUUID()}`,
      },
    }),
  ).rejects.toThrow(/different store/);
  await expect(provider.get({ reference: { providerId: "other", id: saved.id } })).rejects.toThrow(
    /reference/,
  );
});

it("native mutation and shared reads use one operation queue; errors do not poison it", async () => {
  const f = await memoryFixture(tempDirs),
    { provider } = await f.open();
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => [
      f.save(`Concurrent ${i}`),
      provider.search({ query: "Concurrent" }),
      provider.health(),
    ]).flat(),
  );
  expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.message)).toStrictEqual(
    [],
  );
  await expect(provider.search({ query: "" })).rejects.toThrow();
  expect((await provider.search({ query: "Concurrent" })).hits.length).toBe(6);
});

it("unsupported corpus/project filters are explicit, mixed corpus is partial", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Orchid note");
  const { provider } = await f.open();
  await expect(provider.search({ query: "Orchid", sources: ["sessions"] })).rejects.toThrow(
    /transcripts/,
  );
  await expect(provider.search({ query: "Orchid", activeProjectKeys: ["x"] })).rejects.toThrow(
    /project/,
  );
  const mixed = await provider.search({ query: "Orchid", sources: ["sessions", "memory"] });
  expect(mixed.coverage).toBe("partial");
  expect(mixed.warning).toMatch(/not searched/);
  expect(provider.refresh).toBe(undefined);
  await expect(provider.candidates({ kind: "project", activeProjectKeys: ["x"] })).rejects.toThrow(
    /project-key/,
  );
  for (const n of [0, -1, 51, Number.NaN]) {
    await expect(provider.search({ query: "Orchid", maxResults: n })).rejects.toThrow();
  }
});

it("knowledge_recall sets and clears service approval with exact replay", async () => {
  const f = await memoryFixture(tempDirs),
    saved = await f.save("Standing preference", "BODY MUST NEVER BE AUTOMATICALLY INJECTED");
  const before = await f.current(saved.id);
  const input = {
    ...f.fence(before),
    set: {
      summary: "Prefer concise proof reports.",
      triggers: ["proof report"],
      importance: 8,
      projects: ["github.com/openclaw/knowledge"],
    },
  };
  const receipt = await f.service.recall(input, f.tool);
  expect(receipt.state).toBe("published");
  expect(receipt.revision).toBe(before.revision + 1);
  expect(await f.service.recall(input, f.tool)).toStrictEqual(receipt);
  let current = await f.current(saved.id, { includeMetadata: true });
  // Envelope keeps authored recall blocks unvalidated; this one is the service-issued approval.
  const recall = current.metadata!.recall as Recall;
  expect(recall.approved_by).toBe("owner-private");
  expect(Number.isFinite(Date.parse(recall.approved_at))).toBeTruthy();
  expect(recall.summary).toBe(input.set.summary);
  const clear: RecallInput = { ...f.fence(current), clear: true };
  const cleared = await f.service.recall(clear, f.tool);
  expect(cleared.revision).toBe(current.revision + 1);
  expect(await f.service.recall(clear, f.tool)).toStrictEqual(cleared);
  current = await f.current(saved.id, { includeMetadata: true });
  expect(current.metadata!.recall).toBe(undefined);
});

it("knowledge_recall rejects non-owner authority, unavailable writes and invalid metadata", async () => {
  const f = await memoryFixture(tempDirs),
    saved = await f.save("Approval target");
  const base = f.fence(await f.current(saved.id));
  f.setAudience(f.conversation);
  await expect(
    f.service.recall({ ...base, set: { summary: "Private context" } }, f.tool),
  ).rejects.toThrow(/conversation audiences/);
  f.setAudience({ kind: "owner-private", agentId: "main" });
  const operator: any = {
    source: "session-action",
    api: f.api,
    action: { client: { connId: "browser", scopes: ["operator.write"] } },
  };
  await expect(
    f.service.recall({ ...base, set: { summary: "Private context" } }, operator),
  ).rejects.toThrow(/browser and operator/);
  const invalidSets = [
    { summary: "" },
    { summary: "   " },
    { summary: "x".repeat(501) },
    { summary: "ok", triggers: ["bad;phrase"] },
    { summary: "ok", triggers: ["bad\nphrase"] },
    { summary: "ok", triggers: Array(21).fill("phrase") },
    { summary: "ok", importance: 11 },
    { summary: "ok", projects: ["<unsafe>"] },
    { summary: "ok", projects: ["bad\nkey"] },
    { summary: "ok", projects: Array(21).fill("project") },
    { summary: "ok", approved_by: "owner-private" },
    { summary: "ok", approved_at: new Date().toISOString() },
  ];
  for (const set of invalidSets) {
    await expect(
      f.service.recall({ ...base, requestId: randomUUID(), set }, f.tool),
    ).rejects.toThrow(/Invalid automatic recall input/);
  }
  await expect(
    f.service.recall(
      { ...base, requestId: randomUUID(), set: { summary: "ok" }, clear: true },
      f.tool,
    ),
  ).rejects.toThrow(/Invalid automatic recall input/);

  const readOnly = await memoryFixture(tempDirs, { writesEnabled: false });
  await expect(
    readOnly.service.recall(
      { ...readOnly.fence({ id: randomUUID(), revision: 1, hash: "0".repeat(64) }), clear: true },
      readOnly.tool,
    ),
  ).rejects.toThrow(/writes are disabled/);
});

it("automatic candidates select by kind, inject summary only and order deterministically", async () => {
  const f = await memoryFixture(tempDirs);
  const both = await f.save("Both candidate", "SECRET BODY BOTH");
  const project = await f.save("Project candidate", "SECRET BODY PROJECT");
  const trigger = await f.save("Trigger candidate", "SECRET BODY TRIGGER");
  await f.recall(both, {
    summary: "Approved both summary",
    triggers: ["both phrase", "second phrase"],
    importance: 9,
    projects: ["project-a"],
  });
  await f.recall(project, {
    summary: "Approved project summary",
    triggers: ["project phrase"],
    importance: 5,
    projects: ["project-b"],
  });
  await f.recall(trigger, {
    summary: "Approved trigger summary",
    triggers: ["trigger phrase"],
    importance: 5,
  });
  const { provider } = await f.open();
  const triggers = await provider.candidates({ kind: "trigger" });
  const tied = [project.id, trigger.id].toSorted(defaultOrder);
  expect(triggers.hits.map((hit: any) => hit.reference.id)).toStrictEqual([both.id, ...tied]);
  expect(triggers.hits[0].automaticRecall).toStrictEqual({
    eligible: true,
    triggers: "both phrase\nsecond phrase",
    importance: 9,
    projectKeys: ["project-a"],
  });
  expect(triggers.hits[0].citations.length).toBe(1);
  expect(triggers.hits[0].citations[0].reference.id).toBe(both.id);
  expect(triggers.hits[0].citations[0].label).toBe(`knowledge:${both.id}`);
  expect(JSON.stringify(triggers)).not.toMatch(/SECRET BODY/);
  const projects = await provider.candidates({ kind: "project", limit: 1 });
  expect(projects.hits.map((hit: any) => hit.reference.id)).toStrictEqual([both.id]);
  const search = await provider.search({ query: "SECRET" });
  expect(search.hits.every((hit: any) => hit.automaticRecall.eligible === false)).toBeTruthy();
  for (const limit of [0, -1, 201, Number.NaN]) {
    await expect(provider.candidates({ kind: "trigger", limit })).rejects.toThrow();
  }

  f.setAudience(f.conversation);
  const conversationProvider = (await f.open()).provider;
  expect(await conversationProvider.candidates({ kind: "trigger" })).toStrictEqual({
    hits: [],
    coverage: "complete",
    warning: "Automatic recall uses only owner-approved private records.",
  });
});

it("automatic candidates exclude withdrawn, superseded and invalid recall blocks", async () => {
  const f = await memoryFixture(tempDirs);
  const withdrawn = await f.save("Withdrawn candidate");
  await f.recall(withdrawn, { summary: "withdrawn", triggers: ["withdrawn"] });
  await f.service.withdraw(
    { ...f.fence(await f.current(withdrawn.id)), reason: "No longer current" },
    f.tool,
  );
  await expect(f.recall(withdrawn, { summary: "cannot restore" })).rejects.toThrow(
    /unavailable, inactive, invalid, or changed/,
  );

  const superseded = await f.save("Superseded candidate");
  await f.recall(superseded, { summary: "superseded", triggers: ["superseded"] });
  let current = await f.current(superseded.id, { view: "raw" });
  await writeFile(
    path.join(f.root, "private", current.path),
    current.raw!.replace("lifecycle: active", "lifecycle: superseded"),
  );

  const invalid = await f.save("Invalid recall candidate");
  await f.recall(invalid, { summary: "invalid", triggers: ["invalid"] });
  current = await f.current(invalid.id, { view: "raw" });
  await writeFile(
    path.join(f.root, "private", current.path),
    current.raw!.replace("approved_by: owner-private", "approved_by: forged"),
  );

  const { provider } = await f.open();
  expect((await provider.candidates({ kind: "trigger" })).hits).toStrictEqual([]);
  const inspected = await f.service.record({ id: invalid.id }, f.tool);
  expect(inspected.record).toBeTruthy();
  expect(inspected.record!.valid).toBe(true);
  expect(inspected.issues.some((issue) => issue.code === "invalid-recall")).toBeTruthy();
});

it("withdrawn records stay unavailable after external restoration; fixtures are excluded", async () => {
  const f = await memoryFixture(tempDirs);
  const saved = await f.save("Orchid note");
  const { provider } = await f.open();
  const hit = (await provider.search({ query: "Orchid" })).hits[0];
  const detail = await f.current(saved.id, { view: "raw" });
  await f.service.withdraw({ ...f.fence(saved), reason: "Synthetic withdrawal" }, f.tool);
  expect((await provider.search({ query: "Orchid" })).hits.length).toBe(0);
  expect(await provider.get({ reference: hit.reference })).toStrictEqual({ status: "not_found" });
  await writeFile(path.join(f.root, "private", detail.path), detail.raw!);
  expect(await provider.get({ reference: hit.reference })).toStrictEqual({ status: "not_found" });
  const fixtureRecord = await f.save("Synthetic fixture");
  const fixtureDetail = await f.current(fixtureRecord.id, { view: "raw" });
  await writeFile(
    path.join(f.root, "private", fixtureDetail.path),
    fixtureDetail.raw!.replace("lifecycle: active", "record_class: fixture\nlifecycle: active"),
  );
  expect((await provider.search({ query: "Synthetic" })).hits.length).toBe(0);
  expect(
    await provider.get({ reference: { providerId: "knowledge", id: fixtureRecord.id } }),
  ).toStrictEqual({ status: "not_found" });
});

it("retirement drains the shared lane, rollback resumes, close-all fences retained handles", async () => {
  const f = await memoryFixture(tempDirs),
    { provider } = await f.open(),
    runtime = f.capability!.providerRuntime;
  const retirement = runtime.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  await expect(provider.health()).rejects.toThrow(/retiring/);
  await retirement.drain();
  retirement.resume();
  expect((await provider.health()).status).toBe("ready");
  await runtime.closeAllMemorySearchManagers();
  await expect(provider.health()).rejects.toThrow(/closed/);
  expect((await (await f.open()).provider.health()).status).toBe("ready");
});
