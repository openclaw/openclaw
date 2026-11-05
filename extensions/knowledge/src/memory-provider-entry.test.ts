import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureOperation } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import plugin from "./index.js";
import { memoryFixture } from "./memory-provider.test-support.js";
import { deriveMemoryFlushRequestId } from "./service.js";
import {
  hostApi,
  sessionActions,
  stopAtTestEnd,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

it("entry retains native tools, denies untrusted provider callers and prompt honors missing capabilities", async () => {
  const base = tempDirs.make("knowledge-entry-");
  let capability;
  const names: any = [],
    services = [];
  plugin.register(
    hostApi(base, {
      extra: {
        registerMemoryCapability(c: any) {
          capability = c;
        },
        registerService(s: any) {
          services.push(s);
        },
        ...sessionActions(),
        registerTool(_f: any, options: any) {
          names.push(options!.name);
        },
      },
    }).api,
  );
  expect(names.length).toBe(
    Object.values<FeatureOperation>(contract.operations).filter((o) => o.tool).length,
  );
  expect(capability!.recallToolNames).toStrictEqual([
    "knowledge_grep",
    "knowledge_lookup",
    "knowledge_record",
  ]);
  expect(capability!.recallToolNames.every((name: any) => names.includes(name))).toBeTruthy();
  await expect(
    capability!.providerRuntime.open({ cfg: {}, agentId: "main", context: {} }),
  ).rejects.toThrow(/authority/);
  expect(capability!.promptBuilder({ availableTools: new Set() })).toStrictEqual([]);
  // Writes are on by default, so the provider owns the pre-compaction flush.
  expect(capability!.providerFlushPlanResolver({}).persistenceToolNames).toStrictEqual([
    "knowledge_remember",
    "knowledge_save_page",
  ]);
});

it("entry registers without reading the host runtime, as CLI metadata loading requires", () => {
  // The host's CLI-metadata runtime throws on any property read.
  const runtime: any = new Proxy(
    {},
    {
      get(_t, key) {
        throw new Error(`runtime.${String(key)} is unavailable during registration`);
      },
    },
  );
  let capability: any;
  // CLI metadata loading hands registration a deliberately partial API; no single
  // OpenClawPluginApi assertion accepts it (the shared service/session helpers are narrower).
  plugin.register({
    id: "knowledge",
    pluginConfig: {},
    runtime,
    registerMemoryCapability(c: any) {
      capability = c;
    },
    registerService: stopAtTestEnd,
    ...sessionActions(),
    registerTool() {},
  } as never);
  expect(capability!.providerRuntime).toBeTruthy();
});

it("flush plan provides tool persistence only for writable real vaults", async () => {
  const f = await memoryFixture(tempDirs);
  const plan = f.capability!.providerFlushPlanResolver({ contextWindowTokens: 8_000 });
  expect(plan.persistenceToolNames).toStrictEqual(["knowledge_remember", "knowledge_save_page"]);
  expect(plan.lookupToolNames).toStrictEqual([
    "knowledge_grep",
    "knowledge_lookup",
    "knowledge_record",
    "knowledge_ontology",
  ]);
  // Host-owned scheduling, path and model fields stay unset.
  expect(Object.keys(plan).toSorted(defaultOrder)).toStrictEqual([
    "lookupToolNames",
    "persistenceToolNames",
    "prompt",
    "systemPrompt",
  ]);
  const promptText = `${plan.prompt}\n${plan.systemPrompt}`;
  expect(plan.prompt).toMatch(/NO_REPLY/);
  expect([...new Set(promptText.match(/knowledge_[a-z_]+/g))].toSorted(defaultOrder)).toStrictEqual(
    ["knowledge_remember", "knowledge_save_page"],
  );
  expect(f.capability!.providerFlushPlanResolver({ nowMs: 0 }).prompt).toBe(
    f.capability!.providerFlushPlanResolver({ nowMs: Date.UTC(2036, 0, 1) }).prompt,
  );

  const readOnly = await memoryFixture(tempDirs, { writesEnabled: false });
  expect(readOnly.capability!.providerFlushPlanResolver({})).toBe(null);
});

it("flush save derives stable scoped request IDs and preserves exact retry semantics", async () => {
  const f = await memoryFixture(tempDirs);
  const flushContext = (flushId: any, base = f.tool) => ({
    ...base,
    tool: { ...base.tool, memoryFlush: { flushId } },
  });
  const input = {
    expectedVaultId: f.vaultId,
    type: "note",
    title: "Durable project decision",
    body: "The team chose the indexed vault format.",
    source: { text: "We chose the indexed vault format.", attribution: "Conversation excerpt" },
  };
  expect(Check(contract.operations.save_page.input, input)).toBe(true);

  const first = await f.service.save_page(input, flushContext("flush-a"));
  expect(first.requestId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(await f.service.save_page(input, flushContext("flush-a"))).toStrictEqual(first);
  await expect(
    f.service.save_page({ ...input, body: "A different body." }, flushContext("flush-a")),
  ).rejects.toThrow(/different payload/);

  const anotherFlush = await f.service.save_page(input, flushContext("flush-b"));
  const anotherTitle = await f.service.save_page(
    { ...input, title: "Durable owner preference" },
    flushContext("flush-a"),
  );
  expect(anotherFlush.requestId).not.toBe(first.requestId);
  expect(anotherTitle.requestId).not.toBe(first.requestId);
  expect(deriveMemoryFlushRequestId("flush-a", "  DURABLE   project decision  ")).toBe(
    first.requestId,
  );
  await expect(f.service.save_page({ ...input, title: "Outside flush" }, f.tool)).rejects.toThrow(
    /requires requestId outside a host pre-compaction memory flush/,
  );
  const supplied = randomUUID();
  expect(
    (
      await f.service.save_page(
        { ...input, requestId: supplied, title: "Caller ID" },
        flushContext("flush-a"),
      )
    ).requestId,
  ).toBe(supplied);
});

it("flush save follows delegated owner-private and conversation audiences", async () => {
  const f = await memoryFixture(tempDirs);
  const flushContext = (flushId: any) => ({
    ...f.tool,
    tool: { ...f.tool.tool, memoryFlush: { flushId } },
  });
  const privateReceipt = await f.service.save_page(
    { title: "Private flush page", type: "note", body: "Private durable fact." },
    flushContext("private-flush"),
  );
  expect(await readFile(path.join(f.root, "private", privateReceipt.path), "utf8")).toMatch(
    /Private durable fact/,
  );

  f.setAudience(f.conversation);
  const conversationReceipt = await f.service.save_page(
    { title: "Conversation flush page", type: "note", body: "Conversation durable fact." },
    flushContext("conversation-flush"),
  );
  expect(
    await readFile(
      path.join(f.root, "conversations", f.sessionId, conversationReceipt.path),
      "utf8",
    ),
  ).toMatch(/Conversation durable fact/);
  expect((await f.service.record({ id: privateReceipt.id }, f.tool)).record).toBe(null);
  expect((await f.service.record({ id: conversationReceipt.id }, f.tool)).record!.id).toBe(
    conversationReceipt.id,
  );
});

it("grep and lookup expose empty and usable evidence for Active Memory", async () => {
  const f = await memoryFixture(tempDirs);
  const factories = new Map();
  plugin.register({
    ...f.api,
    session: {
      ...f.api.session,
      controls: { ...f.api.session?.controls, ...sessionActions().session.controls },
    },
    registerTool(factory: any, options: any) {
      factories.set(options!.name, factory);
    },
  });
  // The feature adapter must expose the page count in both transcript details and JSON text.
  const assertCount = async (name: any, input: any, count: any, total: any) => {
    const tool = factories.get(name)(f.tool.tool),
      result = await tool.execute(randomUUID(), input);
    for (const output of [result.details, JSON.parse(result.content[0].text)]) {
      expect(output.resultCount).toBe(count);
      expect(output.hits.length).toBe(count);
      expect(output.total).toBe(total);
    }
  };
  await assertCount("knowledge_grep", { query: "Orchid" }, 0, 0);
  await assertCount("knowledge_lookup", { query: "Orchid decision" }, 0, 0);
  await f.save("Orchid decision");
  await assertCount("knowledge_grep", { query: "Orchid" }, 1, 1);
  await assertCount("knowledge_lookup", { query: "Orchid decision" }, 1, 1);
  await assertCount("knowledge_grep", { query: "Orchid", offset: 1 }, 0, 1);
  await assertCount("knowledge_lookup", { query: "Orchid decision", offset: 1 }, 0, 1);
});

it("large provider reads follow advertised line continuations beyond 100000 and disclose opening excerpts", async () => {
  const f = await memoryFixture(tempDirs),
    saved = await f.save("Many lines");
  const filename = path.join(f.root, "private", saved.path),
    raw = await readFile(filename, "utf8");
  await writeFile(
    filename,
    raw.slice(0, -"Evidence-backed durable note".length) + "short\n".repeat(100300) + "needle",
  );
  const { provider } = await f.open();
  const result = await provider.search({ query: "needle" });
  expect(result.hits[0].excerpt).toMatch(/Opening excerpt \(not the match location\)/);
  const first = await provider.get({
    reference: result.hits[0].reference,
    from: 99950,
    lines: 200,
  });
  expect(first.nextFrom > 100000).toBeTruthy();
  const next = await provider.get({ reference: first.reference, from: first.nextFrom, lines: 200 });
  expect(next.status).toBe("ok");
  expect(next.text).toMatch(/needle/);
  expect(next.truncated).toBe(false);
});

it("recall keys and whole candidate responses stay bounded with honest partial coverage", async () => {
  const { stringify } = await import("yaml");
  const { withinBudget } = await import("./response-budget.js");
  const f = await memoryFixture(tempDirs),
    saved = await f.save("Candidate seed");
  await expect(
    f.recall(saved, { summary: "approved", projects: ["x".repeat(501)] }),
  ).rejects.toThrow(/Invalid automatic recall input/);
  await f.recall(saved, { summary: "approved", projects: ["x".repeat(500)] });
  const metadata = (await f.current(saved.id, { metadataView: "full" })).metadata;
  // f.recall above wrote an approved recall block.
  const recall = metadata!.recall as Record<string, unknown>;
  // Many individually bounded records still exceed one response; use authored
  // synthetic fixtures to exercise the production scan/worker/provider chain.
  for (let n = 0; n < 35; n++) {
    const id = randomUUID();
    const m = {
      ...metadata,
      id,
      title: "Candidate " + n,
      recall: {
        ...recall,
        projects: Array.from({ length: 20 }, (_, i) => String(i) + "é".repeat(498)),
        summary: "Approved " + n,
      },
    };
    await writeFile(
      path.join(f.root, "private", path.dirname(saved.path), id + ".md"),
      "---\n" + stringify(m) + "---\nbody",
    );
  }
  const { provider } = await f.open();
  const result = await provider.candidates({ kind: "project", limit: 200 });
  expect(result.hits.length > 0 && result.hits.length < 36).toBeTruthy();
  expect(result.coverage).toBe("partial");
  expect(withinBudget(result)).toBeTruthy();
  expect(result.warning).toMatch(/budget/);
  const limited = await provider.candidates({ kind: "project", limit: 1 });
  expect(limited.hits.length).toBe(1);
  expect(limited.coverage).toBe("partial");
  // A huge manually-authored key must fail closed, never reach automatic recall.
  const id = randomUUID(),
    m = {
      ...metadata,
      id,
      recall: { ...recall, projects: ["x".repeat(1000000)] },
    };
  await writeFile(
    path.join(f.root, "private", path.dirname(saved.path), id + ".md"),
    "---\n" + stringify(m) + "---\nbody",
  );
  const invalid = await provider.candidates({ kind: "project", limit: 200 });
  expect(invalid.coverage).toBe("partial");
  expect(withinBudget(invalid)).toBeTruthy();
  expect(!invalid.hits.some((h: any) => h.reference.id === id)).toBeTruthy();
});
