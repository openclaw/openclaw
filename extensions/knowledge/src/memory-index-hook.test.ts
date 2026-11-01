import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { memoryIndexCutoff, readMemoryIndex } from "./memory-index-hook.js";
import { memoryFixture } from "./memory-provider.test-support.js";
import { parsePolicy } from "./stores-config.js";
import { Stores } from "./stores.js";
import { afterTest, operatorContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// before_prompt_build context for the fixture's owner-private session.
const hookContext = (f: Awaited<ReturnType<typeof memoryFixture>>, overrides = {}) => ({
  agentId: "main",
  sessionKey: f.context.authority.sessionKey,
  sessionId: f.sessionId,
  sandboxed: false,
  memoryAudience: f.context.authority.audience,
  assertMemoryAudienceCurrent: f.context.assertCurrent,
  ...overrides,
});

it("appends a byte-stable index for owner-private sessions until the cutoff moves", async () => {
  const f = await memoryFixture(tempDirs);
  const saved = await f.save("Brightpath analysis playbook");
  const hook = f.hooks.before_prompt_build;
  const messages = [{ role: "user", timestamp: Date.now(), content: "hi" }];
  const first = await hook({ prompt: "hi", messages }, hookContext(f));
  expect(first.appendSystemContext).toContain("- note: Brightpath analysis playbook");
  // Neither a new record nor renaming a listed one changes the index mid-session.
  await f.save("Saved during the session");
  const current = (await f.service.record({ id: saved.id }, f.tool)).record!;
  await f.service.save_page(
    {
      requestId: randomUUID(),
      id: current.id,
      expectedRevision: current.revision,
      expectedHash: current.hash,
      type: "note",
      title: "Renamed playbook title",
      body: "Evidence-backed durable note",
    },
    f.tool,
  );
  const second = await hook({ prompt: "again", messages }, hookContext(f));
  expect(second.appendSystemContext).toBe(first.appendSystemContext);
  // A new session or compaction moves the first retained message, refreshing the index.
  const refreshed = await hook(
    { prompt: "new", messages: [{ role: "compactionSummary", timestamp: Date.now() + 1 }] },
    hookContext(f),
  );
  expect(refreshed.appendSystemContext).toContain("Saved during the session");
});

it("pins the index per physical store, so a binding moved to a fresh store renders its own", async () => {
  let vaultId = "vault-shared";
  const runtime = {
    get vaultId() {
      return vaultId;
    },
    enqueue: (check: () => void, operation: () => unknown) => {
      check();
      return operation();
    },
    client: { call: async () => ({ text: `index of ${vaultId}` }) },
  };
  // Mirrors the Stores members the hook uses: the binding stays, the physical store changes.
  const stub = {
    async ensure() {},
    grantFor: () => undefined,
    async open(_principal: unknown, _options: { provision: boolean }): Promise<unknown> {
      return {
        kind: "ready",
        binding: "agent:main",
        runtime,
        access: { scope: { visibility: "private" }, assertCurrent() {} },
      };
    },
  };
  // SAFETY: readMemoryIndex calls only the members stubbed above.
  const stores = stub as unknown as Stores;
  const ctx = {
    agentId: "main",
    sessionKey: `agent:main:pin-${randomUUID()}`,
    sessionId: randomUUID(),
    sandboxed: false,
    memoryAudience: { kind: "owner-private" as const, agentId: "main" },
    assertMemoryAudienceCurrent() {},
  };
  expect(await readMemoryIndex(stores, ctx, 1)).toBe("index of vault-shared");
  vaultId = "vault-own";
  expect(await readMemoryIndex(stores, ctx, 1)).toBe("index of vault-own");
});

it("a grant revoked while the store opens never releases the pinned private index", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private page title");
  // Real Stores, registry and storage workers over the fixture's host.
  const stores = new Stores(
    f.api,
    parsePolicy({ operatorRead: true, writesEnabled: true }),
    () => {},
  );
  afterTest(() => stores.stop());
  await stores.ensure();
  await stores.registry.call("grant", f.conversation.sessionKey, "read", stores.grants().revision);
  const ctx = hookContext(f, { memoryAudience: f.conversation }),
    asOf = Date.now();
  expect(await readMemoryIndex(stores, ctx, asOf)).toContain("Private page title");
  // Revoke exactly while the next index read opens its store.
  const open = stores.open.bind(stores);
  stores.open = async (...args) => {
    await stores.registry.call(
      "grant",
      f.conversation.sessionKey,
      "none",
      stores.grants().revision,
    );
    return open(...args);
  };
  expect(await readMemoryIndex(stores, ctx, asOf)).toBe("");
});

it("omits the index for conversation, missing and sandboxed audiences and revoked callers", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private page title");
  const hook = f.hooks.before_prompt_build;
  const event = { prompt: "hi", messages: [] };
  const conversation = f.conversation;
  expect(await hook(event, hookContext(f, { memoryAudience: conversation }))).toBeUndefined();
  expect(await hook(event, hookContext(f, { memoryAudience: undefined }))).toBeUndefined();
  expect(await hook(event, hookContext(f, { sandboxed: true }))).toBeUndefined();
  f.revoke();
  expect(await hook(event, hookContext(f))).toBeUndefined();
});

it("injects the index into conversations an owner granted read access, threads included", async () => {
  const f = await memoryFixture(tempDirs);
  await f.save("Private page title");
  const hook = f.hooks.before_prompt_build;
  const event = { prompt: "hi", messages: [] };
  const thread = { ...f.conversation, sessionKey: `${f.conversation.sessionKey}:thread:7` };
  const admin = operatorContext(f.api, ["operator.admin"]);
  for (const [access, injected] of [
    ["read", true],
    ["read-write", true],
    ["none", false],
  ] as const) {
    const { grants } = await f.service.stores_snapshot({}, admin);
    const changed = await f.service.stores_grant(
      { expectedRevision: grants.revision, sessionKey: f.conversation.sessionKey, access },
      admin,
    );
    expect(changed.outcome).toBe("applied");
    const result = await hook(event, hookContext(f, { memoryAudience: thread }));
    expect(result?.appendSystemContext?.includes("Private page title") ?? false).toBe(injected);
  }
});

it("uses the first retained message timestamp, never a later one", () => {
  expect(memoryIndexCutoff([{ timestamp: 5 }, { timestamp: 9 }], 100)).toBe(5);
  expect(memoryIndexCutoff([{ timestamp: "1970-01-01T00:00:00.007Z" }], 100)).toBe(7);
  expect(memoryIndexCutoff([{ role: "user" }], 100)).toBe(100);
  expect(memoryIndexCutoff([{ timestamp: 500 }], 100)).toBe(100);
});
