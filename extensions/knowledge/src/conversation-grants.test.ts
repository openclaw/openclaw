import { randomUUID } from "node:crypto";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { featurePrincipal } from "./access.js";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { parsePolicy } from "./stores-config.js";
import type { GrantChangeInput } from "./stores-contract.js";
import { Stores } from "./stores.js";
import {
  afterTest,
  defaultOrder,
  hostApi,
  operatorContext,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();
const GROUP = "agent:main:discord:channel:123";

async function fixture(options = {}) {
  const base = tempDirs.make("knowledge-grants-");
  const services: any = [];
  let capability: any;
  const host = hostApi(base, {
    agents: ["main", "research"],
    policy: { operatorRead: true, writesEnabled: true },
    ...options,
    extra: {
      registerService: (s: any) => services.push(s),
      registerMemoryCapability: (c: any) => (capability = c),
    },
  });
  const service = createKnowledgeService(host.api);
  afterTest(() => services.forEach((s: any) => s.stop()));
  const admin = operatorContext(host.api, ["operator.admin"]);
  const owner = toolContext(host.api, "main");
  // A host-minted conversation audience for a session key; each key is its own conversation.
  const sessionIds = new Map<string, string>();
  const chat = (sessionKey: string) => {
    sessionIds.set(sessionKey, sessionIds.get(sessionKey) ?? randomUUID());
    return toolContext(host.api, "main", {
      kind: "conversation",
      agentId: "main",
      sessionKey,
      sessionId: sessionIds.get(sessionKey),
    });
  };
  const save = (ctx: FeatureInvocationContext, title: string) =>
    service.save_page(
      { requestId: randomUUID(), title, type: "note", body: title + " body." },
      ctx,
    );
  const titles = async (ctx: FeatureInvocationContext) =>
    (await service.records({}, ctx)).records.map((r) => r.title).toSorted(defaultOrder);
  const grant = async (sessionKey: string, access: GrantChangeInput["access"], context = admin) => {
    const input = {
      expectedRevision: (await service.stores_snapshot({}, admin)).grants.revision,
      sessionKey,
      access,
    };
    expect(Check(contract.operations.stores_grant.input, input)).toBeTruthy();
    const result = await service.stores_grant(input, context);
    expect(Check(contract.operations.stores_grant.output, result), JSON.stringify(result)).toBe(
      true,
    );
    return result;
  };
  return {
    ...host,
    services,
    service,
    admin,
    owner,
    chat,
    save,
    titles,
    grant,
    capability: () => capability,
  };
}

it("an owner grant lets a group read, save, or both in the agent's private knowledge", async () => {
  const f = await fixture();
  const group = f.chat(GROUP),
    thread = f.chat(GROUP + ":thread:42"),
    other = f.chat("agent:main:discord:channel:1234");
  await f.save(f.owner, "Owner plan");
  // Ungranted: the group keeps its own conversation partition.
  await f.save(group, "Group note");
  expect(await f.titles(group)).toStrictEqual(["Group note"]);
  expect(await f.titles(f.owner)).toStrictEqual(["Owner plan"]);

  expect((await f.grant(GROUP, "read")).outcome).toBe("applied");
  expect(await f.titles(group)).toStrictEqual(["Owner plan"]);
  // Threads inherit their conversation's grant; a key that merely shares a prefix does not.
  expect(await f.titles(thread)).toStrictEqual(["Owner plan"]);
  expect(await f.titles(other)).toStrictEqual([]);
  await expect(f.save(group, "Not allowed")).rejects.toThrow(/read-only in this conversation/);
  await expect(f.save(thread, "Not allowed")).rejects.toThrow(/read-only/);
  expect((await f.service.status({}, group)).writesEnabled).toBe(false);
  // Save guidance leaves the read-only conversation's prompt; the owner keeps it.
  const tools = new Set(["knowledge_grep", "knowledge_remember"]);
  const prompt = (agentSessionKey: string) =>
    f.capability().promptBuilder({ availableTools: tools, agentSessionKey }).join("\n");
  expect(prompt(GROUP + ":thread:42")).not.toContain("knowledge_remember");
  expect(prompt("agent:main:main")).toContain("knowledge_remember");

  expect((await f.grant(GROUP, "read-write")).outcome).toBe("applied");
  await f.save(group, "Group decision");
  expect(await f.titles(f.owner)).toStrictEqual(["Group decision", "Owner plan"]);

  await f.save(thread, "Thread fact");
  expect(await f.titles(thread)).toStrictEqual(["Group decision", "Owner plan", "Thread fact"]);

  // Revoking restores the group's own partition; nothing else changed along the way.
  expect((await f.grant(GROUP, "none")).outcome).toBe("applied");
  expect(await f.titles(group)).toStrictEqual(["Group note"]);
  expect(await f.titles(other)).toStrictEqual([]);
  expect(f.host.config.plugins.entries.knowledge.config).not.toHaveProperty("conversationGrants");
});

it("revoking or narrowing a grant fences work already resolved against it", async () => {
  const f = await fixture();
  await f.save(f.owner, "Owner plan");
  const stores = new Stores(
    f.api,
    parsePolicy({ operatorRead: true, writesEnabled: true }),
    () => {},
  );
  afterTest(() => stores.stop());
  await stores.ensure();
  const setGrant = (access: string) =>
    stores.registry.call("grant", GROUP, access as "read", stores.grants().revision);
  await setGrant("read-write");
  const open = async (write: boolean) => {
    const opened = await stores.open(
      featurePrincipal(f.chat(GROUP), true, write, "main", stores.grantFor),
      { provision: false },
    );
    if (opened.kind !== "ready") {
      throw new Error("expected a ready store");
    }
    expect(opened.access.scope).toStrictEqual({ visibility: "private" });
    return opened.access;
  };
  const [reading, writing] = [await open(false), await open(true)];
  await setGrant("read");
  reading.assertCurrent();
  expect(() => writing.assertCurrent()).toThrow(/read-only/);
  await setGrant("none");
  expect(() => reading.assertCurrent()).toThrow(/authority is required/);
});

it("grant changes need operator admin and the current revision, and persist in the registry", async () => {
  const f = await fixture();
  await f.save(f.owner, "Owner plan");
  const writer = operatorContext(f.api, ["operator.write"]);
  expect((await f.grant(GROUP, "read", writer)).outcome).toBe("forbidden");
  const stale = (await f.service.stores_snapshot({}, f.admin)).grants.revision;
  expect((await f.grant(GROUP, "read")).outcome).toBe("applied");
  const conflict = await f.service.stores_grant(
    { expectedRevision: stale, sessionKey: GROUP, access: "none" },
    f.admin,
  );
  expect(conflict.outcome).toBe("conflict");
  expect(conflict.snapshot!.grants.entries).toStrictEqual([
    { sessionKey: GROUP, agent: "main", access: "read" },
  ]);
  expect((await f.grant("agent:ghost:discord:channel:1", "read")).outcome).toBe("invalid");
  // The operator's agent ceiling is checked at the write, after every await.
  let allowsMain = true;
  const roleScoped = operatorContext(f.api, ["operator.admin"]);
  roleScoped.action.client.allowsAgent = (agent: string) => agent !== "main" || allowsMain;
  const pending = f.service.stores_grant(
    {
      expectedRevision: (await f.service.stores_snapshot({}, f.admin)).grants.revision,
      sessionKey: "agent:main:discord:channel:777",
      access: "read-write",
    },
    roleScoped,
  );
  allowsMain = false;
  expect((await pending).outcome).toBe("forbidden");
  expect(
    (await f.service.stores_snapshot({}, f.admin)).grants.entries.map((e) => e.sessionKey),
  ).toStrictEqual([GROUP]);
  // Losing access while the registry write is queued undoes the committed grant.
  let checks = 0;
  const disconnecting = operatorContext(f.api, ["operator.admin"], () => {
    if (++checks > 1) {
      throw new Error("connection closed");
    }
  });
  const late = await f.service.stores_grant(
    {
      expectedRevision: (await f.service.stores_snapshot({}, f.admin)).grants.revision,
      sessionKey: "agent:main:discord:channel:888",
      access: "read",
    },
    disconnecting,
  );
  expect(late.outcome).toBe("forbidden");
  expect(
    (await f.service.stores_snapshot({}, f.admin)).grants.entries.map((e) => e.sessionKey),
  ).toStrictEqual([GROUP]);
  // Final effect: the room never reads private knowledge through the reverted grant.
  expect(await f.titles(f.chat("agent:main:discord:channel:888"))).toStrictEqual([]);
  // Grants are Knowledge state, not configuration, and survive a restart.
  expect(f.host.config.plugins.entries.knowledge.config).not.toHaveProperty("conversationGrants");
  await Promise.all(f.services.map((s: any) => s.stop()));
  const restarted = createKnowledgeService(f.api);
  expect((await restarted.records({}, f.chat(GROUP))).records.map((r) => r.title)).toStrictEqual([
    "Owner plan",
  ]);
});

it("a memory-provider lease opened first after a restart sees the persisted grant", async () => {
  const f = await fixture();
  await f.save(f.owner, "Owner plan");
  await f.grant(GROUP, "read");
  await Promise.all(f.services.map((s: any) => s.stop()));
  createKnowledgeService(f.api);
  const lease = await f.capability().providerRuntime.open({
    cfg: {},
    agentId: "main",
    context: {
      authority: {
        kind: "session",
        sessionKey: GROUP,
        sandboxed: false,
        audience: {
          kind: "conversation",
          agentId: "main",
          sessionKey: GROUP,
          sessionId: randomUUID(),
        },
      },
      assertCurrent() {},
    },
  });
  expect((await lease.provider.search({ query: "Owner plan" })).hits.length).toBeGreaterThan(0);
});

it("conversations granted saves can approve automatic recall; read-only and ungranted ones cannot", async () => {
  const f = await fixture();
  const saved = await f.save(f.owner, "Standing preference");
  const recall = async (ctx: FeatureInvocationContext) => {
    const record = (await f.service.record({ id: saved.id }, f.owner)).record!;
    return f.service.recall(
      {
        requestId: randomUUID(),
        id: record.id,
        expectedRevision: record.revision,
        expectedHash: record.hash,
        set: { summary: "Prefers short answers." },
      },
      ctx,
    );
  };
  await expect(recall(f.chat(GROUP))).rejects.toThrow(/owner grant to read and save/);
  await f.grant(GROUP, "read");
  await expect(recall(f.chat(GROUP))).rejects.toThrow(/read-only/);
  await f.grant(GROUP, "read-write");
  // Approval is the first call after a restart; the persisted grant still applies.
  const record = (await f.service.record({ id: saved.id }, f.owner)).record!;
  await Promise.all(f.services.map((s: any) => s.stop()));
  const restarted = createKnowledgeService(f.api);
  const approved = await restarted.recall(
    {
      requestId: randomUUID(),
      id: record.id,
      expectedRevision: record.revision,
      expectedHash: record.hash,
      set: { summary: "Prefers short answers." },
    },
    f.chat(GROUP + ":thread:3"),
  );
  expect(approved.state).toBe("published");
  const raw = (await restarted.record({ id: saved.id, view: "raw" }, f.owner)).record!.raw!;
  expect(raw).toContain("Prefers short answers.");
  expect(raw).toContain("approved_by: owner-private");
});
