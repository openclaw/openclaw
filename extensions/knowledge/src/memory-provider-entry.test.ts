import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureOperation } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import plugin from "./index.js";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";
import { memoryFixture } from "./memory-provider.test-support.js";
import { deriveMemoryFlushRequestId } from "./service.js";
import type { Stores } from "./stores.js";
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
  // A host readiness lease validates storage but never releases content.
  const status = (
    await capability!.providerRuntime.open({
      cfg: {},
      agentId: "main",
      purpose: "status",
      context: { authority: { kind: "host", operation: "status" }, assertCurrent() {} },
    })
  ).provider;
  expect(await status.health()).toStrictEqual({
    status: "ready",
    message: "Knowledge vault readiness check.",
  });
  await expect(status.search({ query: "anything" })).rejects.toThrow(/authority/);
  await expect(
    capability!.providerRuntime.open({ cfg: {}, agentId: "main", context: {} }),
  ).rejects.toThrow(/authority/);
  expect(capability!.promptBuilder({ availableTools: new Set() })).toStrictEqual([]);
  // Writes are on by default, so the provider owns the pre-compaction flush.
  expect(capability!.providerFlushPlanResolver({}).persistenceToolNames).toStrictEqual([
    "knowledge_remember",
    "knowledge_save_page",
  ]);
  expect(buildKnowledgeMemoryPrompt({ availableTools: new Set() })).toStrictEqual([]);
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
  expect(plan.relativePath).toBe(undefined);
  expect(plan.reserveTokensFloor).toBe(undefined);
  expect(plan.softThresholdTokens).toBe(undefined);
  expect(plan.forceFlushTranscriptBytes).toBe(undefined);
  expect(plan.model).toBe(undefined);
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

  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: f.sessionId,
  });
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

it("prompt routes all workflows, obeys citation settings and omits disabled save guidance", async () => {
  const tools = new Set(
    Object.values<FeatureOperation>(contract.operations).flatMap((o) =>
      o.tool ? [o.tool.name] : [],
    ),
  );
  const full = buildKnowledgeMemoryPrompt({ availableTools: tools }).join("\n");
  for (const skill of ["recall", "capture", "ingest", "meeting-ingest", "entities", "correct"]) {
    expect(full.includes(`knowledge-${skill}`)).toBeTruthy();
  }
  expect(full).toMatch(/not instructions or authorization/);
  expect(full).toMatch(/newer text is not automatically truer/);
  expect(full).toMatch(/knowledge_recall only when the owner asks/);
  expect(full).toMatch(/never ingested source text/);
  expect(full).toMatch(/Unprompted and silently, save decisions with rationale/);
  expect(full).toMatch(/before your final reply on a task where one occurred/);
  expect(full).toMatch(/knowledge_remember: .*no search or readback first/);
  expect(full).toMatch(
    /fast path for one-off information: no search or readback first, and no page is needed/,
  );
  expect(full).toMatch(/each person, organization or project the user discusses as significant/);
  expect(full).toMatch(/create it now, without waiting to see whether the work continues/);
  // The call shape models get wrong: a fresh requestId and items, not claims.
  expect(full).toMatch(/a fresh requestId \(a new UUID\).*an items array \(not claims\)/);
  expect(full).toMatch(/knowledge-capture to revise a page's prose/);
  // Entities are the catch-all memory subject; named entities trigger one search before planning.
  expect(full).toMatch(
    /user's world: entities \(.*any other thing the active ontology can represent\)/,
  );
  expect(full).toMatch(
    /before planning a task that names an entity or refers to earlier work, run knowledge_grep/,
  );
  // Sustained work gets a maintained entity page; findings go there, not into source-claim remembering.
  expect(full).toMatch(
    /Entity pages: work that spans several turns.*create it now.*through knowledge-entities/,
  );
  expect(full).toMatch(/record your own findings there, labelled as your analysis/);
  expect(full).toMatch(/Record your own findings on pages instead/);
  expect(full).toMatch(/worded no more broadly than its excerpt supports/);
  const readOnly = await memoryFixture(tempDirs, { writesEnabled: false });
  expect(readOnly.capability!.promptBuilder({ availableTools: tools }).join("\n")).not.toMatch(
    /knowledge_remember|knowledge-capture|knowledge-correct|knowledge_recall only/,
  );
  const partial = buildKnowledgeMemoryPrompt({
    availableTools: new Set(["knowledge_grep"]),
    citationsMode: "off",
  }).join("\n");
  expect(partial).not.toMatch(/knowledge_record|knowledge_lookup|knowledge-capture/);
  expect(partial).toMatch(/Citations are disabled/);
  expect(partial).toMatch(
    /refers to earlier work, run knowledge_grep once on each entity it names, not only the first\./,
  );
  const rememberWithoutPages = buildKnowledgeMemoryPrompt({
    availableTools: new Set(["knowledge_grep", "knowledge_remember"]),
  }).join("\n");
  expect(rememberWithoutPages).toMatch(/Skip your own inference/);
  expect(rememberWithoutPages).not.toMatch(/Entity pages|on pages instead/);
  expect(
    buildKnowledgeMemoryPrompt({ availableTools: new Set(["knowledge_recall"]) }).join("\n"),
  ).toMatch(/owner asks.*recalled automatically/);
});

it("prompt names repository project keys only for remote keys, gated by the tools that use them", () => {
  const tools = new Set(
    Object.values<FeatureOperation>(contract.operations).flatMap((o) =>
      o.tool ? [o.tool.name] : [],
    ),
  );
  const prompt = (projectKey: any, available = tools) =>
    buildKnowledgeMemoryPrompt({ availableTools: available, projectKey }).join("\n");
  const full = prompt("github.com/acme/widget");
  expect(full).toMatch(
    /repository key is `github\.com\/acme\/widget`, an alias of its project page: pass it as the knowledge_remember subject for claims about this repository's work, and omit it for claims about anything else/,
  );
  expect(full).toMatch(
    /If no page answers to `github\.com\/acme\/widget`.*add it as an alias.*knowledge-entities/,
  );
  for (const key of [
    undefined,
    "",
    "path:/srv/workspace",
    "github.com/a<b",
    "github.com/a\nb",
    "github.com/a`b",
  ]) {
    expect(prompt(key)).not.toMatch(/repository key|answers to `/);
  }
  expect(prompt("github.com/acme/widget", new Set(["knowledge_grep"]))).not.toMatch(
    /repository key|answers to `/,
  );
  const rememberOnly = prompt(
    "github.com/acme/widget",
    new Set(["knowledge_grep", "knowledge_remember"]),
  );
  expect(rememberOnly).toMatch(/repository key/);
  expect(rememberOnly).not.toMatch(/answers to `/);
});

// Storage runs in a worker, so this drives the provider with a stub storage
// client: its own fencing is what must reject failures and late results.
it("index failure is not empty success and late backend results are fenced", async () => {
  const { createKnowledgeMemoryRuntime } = await import("./memory-provider.js");
  const sessionId = randomUUID();
  let active = true,
    reply: any;
  const client = {
    async call(op: any) {
      expect(op).toBe("search");
      return reply();
    },
  };
  const runtime = {
    vaultId: randomUUID(),
    client,
    enqueue: (check: any, operation: any) => {
      check();
      return operation();
    },
  };
  // Mirrors the Stores members the provider uses; the stub has no registry or runtimes.
  const stores = {
    policy: { operatorRead: true },
    incarnation: 0,
    assertLive(_epoch: number) {},
    async open(principal: any, _options: { provision: boolean }): Promise<unknown> {
      return {
        kind: "ready",
        runtime,
        access: {
          ...principal(),
          assertCurrent: () => {
            principal();
          },
        },
      };
    },
  };
  const context: any = {
    authority: {
      kind: "session",
      sessionKey: "agent:main:test",
      sessionId,
      sandboxed: false,
      audience: { kind: "owner-private", agentId: "main" },
    },
    assertCurrent() {
      if (!active) {
        throw new Error("caller revoked");
      }
    },
  };
  const { provider } = await createKnowledgeMemoryRuntime(stores as Stores).open({
    cfg: {},
    agentId: "main",
    context,
  });
  reply = () => ({ index: { state: "unavailable", message: "Index unavailable; retry" } });
  await expect(provider!.search({ query: "Orchid" })).rejects.toThrow(/Index unavailable/);
  reply = () => {
    active = false;
    return {
      index: { state: "ready", snapshot: "s", message: "" },
      hits: [],
      total: 0,
      nextOffset: null,
      coverage: { complete: true, message: "" },
    };
  };
  await expect(provider!.search({ query: "Orchid" })).rejects.toThrow(/revoked/);
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
  const original = (await f.service.record({ id: saved.id, metadataView: "full" }, f.tool)).record;
  const metadata = original!.metadata;
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
