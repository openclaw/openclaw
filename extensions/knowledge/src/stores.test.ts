import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import type { Principal } from "./access.js";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { StoreRegistry } from "./store-registry.js";
import { parsePolicy, storesRevision, type StoresSection } from "./stores-config.js";
import { Stores } from "./stores.js";
import {
  hostApi,
  toolContext,
  operatorContext,
  afterTest,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

type Service = ReturnType<typeof createKnowledgeService>;
// agent_query returns `unknown`; the proxy has already validated it against this operation's schema.
type Output<Op extends keyof Service> = Awaited<ReturnType<Service[Op]>>;
// The host's config mutation callback, which these tests drive directly.
type Mutate = Parameters<OpenClawPluginApi["runtime"]["config"]["mutateConfigFile"]>[0]["mutate"];

// Every scenario starts from an empty Knowledge state root: stores exist only
// once an agent uses one, exactly as on a fresh install.
async function fixture(options = {}) {
  const base = tempDirs.make("knowledge-stores-");

  const services: any = [];
  const host = hostApi(base, {
    agents: ["main", "research", "ops"],
    policy: { operatorRead: true, writesEnabled: true },
    ...options,
    extra: { registerService: (s: any) => services.push(s) },
  });
  const service = createKnowledgeService(host.api);
  afterTest(() => services.forEach((s: any) => s.stop()));
  const admin = operatorContext(host.api, ["operator.admin"]),
    reader = operatorContext(host.api, ["operator.read"]);
  const as = (agent: any) => toolContext(host.api, agent);
  const save = (agent: any, title: any, via = service) =>
    via.save_page(
      { requestId: randomUUID(), title, type: "note", body: `${title} body.` },
      as(agent),
    );
  const titles = async (agent: any) =>
    (await service.records({}, as(agent))).records.map((r) => r.title).toSorted(defaultOrder);
  const snapshot = () => service.stores_snapshot({}, admin);
  const change = async (agent: any, requested: any, expectedRevision?: string) => {
    const input = {
      requestId: randomUUID(),
      expectedRevision: expectedRevision ?? (await snapshot()).revision,
      agent,
      change: requested,
    };
    expect(Check(contract.operations.stores_change.input, input)).toBeTruthy();
    const result = await service.stores_change(input, admin);
    expect(
      Check(contract.operations.stores_change.output, result),
      JSON.stringify(result),
    ).toBeTruthy();
    return { input, result };
  };
  const share = (agent: string, agents: string[], label = "Team") =>
    change(agent, { kind: "share_existing", label, agents });
  const outcome = async (agent: string, requested: any, expectedRevision?: string) =>
    (await change(agent, requested, expectedRevision)).result.outcome;
  const storesDir = () => readdir(path.join(host.stateRoot, "stores")).catch(() => []);
  // The fixture host types plugin config loosely; these tests only author valid store sections.
  const storesSection = () =>
    host.host.config.plugins.entries.knowledge.config.stores as StoresSection;
  return {
    ...host,
    base,
    service,
    admin,
    reader,
    as,
    save,
    titles,
    snapshot,
    change,
    share,
    outcome,
    storesDir,
    storesSection,
  };
}
const entry = (snapshot: any, binding: any) =>
  snapshot.stores.find((s: any) => s.binding === binding);
// An operator's proxied read of the research agent's store.
const query = (f: Awaited<ReturnType<typeof fixture>>, operation: string, input = {}) =>
  f.service.agent_query({ agent: "research", operation, input }, f.reader);

it("membership decodes each published revision once and rejects changed ambiguous assignments", async () => {
  const base = tempDirs.make("knowledge-membership-");
  const host = hostApi(base, { agents: ["main", "research"] });
  const stores = new Stores(host.api, parsePolicy(undefined), () => {});
  afterTest(() => stores.stop());
  const section = { team: { agents: ["research"] } };
  const serialized = JSON.stringify(section);
  await stores.registry.call("reconcile", serialized, storesRevision(section));
  const parse = vi.spyOn(JSON, "parse");
  try {
    const first = stores.membership();
    for (let i = 0; i < 8; i++) {
      expect(stores.membership()).toBe(first);
    }
    expect(first.assigned.get("research")).toBe("team");
    expect(parse.mock.calls.filter(([text]) => text === serialized)).toHaveLength(1);

    const changed = { ...section, other: { agents: ["research"] } };
    const nextSerialized = JSON.stringify(changed);
    await stores.registry.call("reconcile", nextSerialized, storesRevision(changed));
    const next = stores.membership();
    expect(next).not.toBe(first);
    expect(next.invalid.has("research")).toBe(true);
    expect(next.assigned.has("research")).toBe(false);
    expect(stores.membership()).toBe(next);
    expect(parse.mock.calls.filter(([text]) => text === nextSerialized)).toHaveLength(1);
  } finally {
    parse.mockRestore();
  }
});

it("two unassigned agents get separate stores on first use and cannot read each other", async () => {
  const f = await fixture();
  await f.save("main", "Main private");
  await f.save("research", "Research private");
  expect(await f.titles("main")).toStrictEqual(["Main private"]);
  expect(await f.titles("research")).toStrictEqual(["Research private"]);
  expect((await f.storesDir()).length).toBe(2);
});

it("passive discovery, including operator provider reads, never creates storage", async () => {
  const f = await fixture();
  let runtime: any;
  createKnowledgeService({
    ...f.api,
    registerMemoryCapability(c) {
      runtime = c.providerRuntime;
    },
  });
  const { provider } = await runtime.open({
    cfg: {},
    agentId: "research",
    context: {
      authority: { kind: "operator", connId: "x", scopes: ["operator.read"] },
      assertCurrent() {},
    },
  });
  await expect(provider.search({ query: "anything" })).rejects.toThrow(/first authorized use/);
  expect((await provider.health()).status).toBe("ready");
  const snap = await f.snapshot();
  expect(Check(contract.operations.stores_snapshot.output, snap)).toBeTruthy();
  expect(snap.agents.map((a) => [a.id, a.binding])).toStrictEqual([
    ["main", "agent:main"],
    ["research", "agent:research"],
    ["ops", "agent:ops"],
  ]);
  expect(snap.stores.every((s) => s.state === "unprovisioned")).toBeTruthy();
  const status = await f.service.status({}, f.reader);
  expect(status.store).toBe("unprovisioned");
  expect(((await query(f, "records")) as Output<"records">).total).toBe(0);
  expect(((await query(f, "status")) as Output<"status">).store).toBe("unprovisioned");
  expect(await f.storesDir()).toStrictEqual([]);
});

it("concurrent first uses converge on one store identity", async () => {
  const f = await fixture();
  await Promise.all([f.save("main", "One"), f.save("main", "Two"), f.save("main", "Three")]);
  expect((await f.storesDir()).length).toBe(1);
  expect(await f.titles("main")).toStrictEqual(["One", "Three", "Two"]);
});

it.each([
  ["before any file work", false],
  ["after creating its manifest and database files", true],
])("initialization interrupted %s resumes the same identity", async (_point, filesCreated) => {
  const f = await fixture();
  // Simulate a crash after the reservation committed.
  const reserve = new StoreRegistry(f.stateRoot);
  reserve["tx"](() => {
    reserve["db"]
      .prepare("INSERT INTO stores VALUES (?,?,?,?,'initializing',?)")
      .run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111", "vault"),
        path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111", "state.sqlite"),
        new Date().toISOString(),
      );
    reserve["db"]
      .prepare(
        "INSERT INTO bindings(binding,vault_id) VALUES ('agent:main','11111111-1111-4111-8111-111111111111')",
      )
      .run();
  });
  reserve.close();
  if (filesCreated) {
    // Exclusive creates succeeded, then the process died before writing either file.
    const dir = path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111");
    await mkdir(path.join(dir, "vault", "private"), { recursive: true });
    await writeFile(path.join(dir, "vault", "vault.json"), "");
    await writeFile(path.join(dir, "state.sqlite"), "");
  }
  await f.save("main", "After crash");
  expect(await f.storesDir()).toStrictEqual(["11111111-1111-4111-8111-111111111111"]);
  expect((await f.service.status({}, f.as("main"))).vault).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
});

it("a provisioned store that disappears is unavailable, never recreated empty", async () => {
  const f = await fixture();
  await f.save("main", "Kept");
  const [dir] = await f.storesDir();
  await rename(path.join(f.stateRoot, "stores", dir!), path.join(f.base, "moved-away"));
  const fresh = createKnowledgeService(f.api);
  await expect(f.save("main", "Must not land", fresh)).rejects.toThrow(/identity|unavailable/);
  expect(entry(await fresh.stores_snapshot({}, f.admin), "agent:main").state).toBe("unavailable");
  expect(await f.storesDir()).toStrictEqual([]);
});

it.each([
  ["missing", (file: string, base: string) => rename(file, path.join(base, "registry.bak"))],
  ["emptied", (file: string) => writeFile(file, "")],
])(
  "a %s registry beside existing stores requires recovery, never fresh empty stores",
  async (_case, damage) => {
    const f = await fixture();
    await f.save("main", "Kept");
    await damage(path.join(f.stateRoot, "registry.sqlite"), f.base);
    const fresh = createKnowledgeService(f.api);
    await expect(f.save("main", "x", fresh)).rejects.toThrow(/registry/);
    const snap = await fresh.stores_snapshot({}, f.admin);
    expect(snap.canChange).toBe(false);
    expect(snap.issues[0]).toMatch(/registry/);
    expect((await f.storesDir()).length).toBe(1);
  },
);

it("share existing: same identity and records; members read and update through one store", async () => {
  const f = await fixture();
  await f.save("main", "Before sharing");
  const before = await f.service.status({}, f.as("main"));
  const { result } = await f.share("main", ["research"], "Personal");
  expect(result.outcome, result.message).toBe("applied");
  const shared = entry(result.snapshot, "named:personal");
  expect(shared.members).toStrictEqual(["main", "research"]);
  expect(shared.label).toBe("Personal");
  expect(
    entry(result.snapshot, "agent:main"),
    "the original isolated binding moved to the named store",
  ).toBe(undefined);
  expect((await f.service.status({}, f.as("research"))).vault).toBe(before.vault);
  expect(await f.titles("research")).toStrictEqual(["Before sharing"]);
  await f.save("research", "Research addition");
  expect(await f.titles("main")).toStrictEqual(["Before sharing", "Research addition"]);
  // Writer attribution follows the publishing agent, not the viewer.
  const records = (await f.service.records({}, f.as("main"))).records;
  expect(records.find((r) => r.title === "Research addition")!.writtenByAgentId).toBe("research");
  expect(records.find((r) => r.title === "Before sharing")!.writtenByAgentId).toBe("main");
  // Configuration holds membership; nothing wrote an agent path.
  expect(f.host.config.plugins.entries.knowledge.config.stores).toStrictEqual({
    personal: { label: "Personal", agents: ["main", "research"] },
  });
  expect((await f.storesDir()).length).toBe(1);
});

it("use own after sharing: joiner resumes its old store; originating sharer gets a fresh lazy default", async () => {
  const f = await fixture();
  await f.save("main", "Shared seed");
  await f.save("research", "Research own");
  expect((await f.share("main", ["research"])).result.outcome).toBe("applied");
  expect(await f.titles("research")).toStrictEqual(["Shared seed"]);
  const back = await f.change("research", { kind: "use_own" });
  expect(back.result.outcome, back.result.message).toBe("applied");
  expect(await f.titles("research")).toStrictEqual(["Research own"]);
  const own = await f.change("main", { kind: "use_own" });
  expect(own.result.outcome).toBe("applied");
  expect(entry(own.result.snapshot, "agent:main").state).toBe("unprovisioned");
  // Zero members: the named store is retained with its data and stays assignable.
  const team = entry(own.result.snapshot, "named:team");
  expect(team.members).toStrictEqual([]);
  expect(team.state).toBe("ready");
  expect(await f.titles("main")).toStrictEqual([]);
  expect(await f.outcome("ops", { kind: "use_named", store: "team" })).toBe("applied");
  expect(await f.titles("ops")).toStrictEqual(["Shared seed"]);
});

it("switching named stores leaves one assignment and the former store untouched", async () => {
  const f = await fixture();
  await f.save("main", "Alpha");
  await f.save("ops", "Beta");
  await f.share("main", ["research"], "A");
  const b = await f.share("ops", ["main"], "B");
  expect(b.result.outcome, b.result.message).toBe("applied");
  const stores = f.storesSection();
  expect(stores.a!.agents).toStrictEqual(["research"]);
  expect(stores.b!.agents).toStrictEqual(["ops", "main"]);
  expect(await f.titles("main")).toStrictEqual(["Beta"]);
  expect(await f.titles("research")).toStrictEqual(["Alpha"]);
});

it("store counts follow the operator's live agent role and shared-Gateway policy", async () => {
  const f = await fixture();
  await f.save("main", "Main note");
  await f.save("research", "Research note");
  const counts = async (client: Record<string, unknown>) => {
    const context = operatorContext(f.api, ["operator.read"]);
    Object.assign(context.action.client, client);
    const snap = await f.service.stores_snapshot({}, context);
    return Object.fromEntries(snap.stores.map((s) => [s.binding, s.records]));
  };
  expect(await counts({ scopes: ["operator.admin"] })).toMatchObject({
    "agent:main": 1,
    "agent:research": 1,
  });
  // A role limited to main never learns how much research has stored.
  expect(await counts({ allowsAgent: (id: string) => id === "main" })).toMatchObject({
    "agent:main": 1,
    "agent:research": null,
  });
  // On a shared Gateway, private counts need an administrator.
  expect(await counts({ isSharedGateway: () => true })).toMatchObject({
    "agent:main": null,
    "agent:research": null,
  });
});

it("an operator whose access ends before the config write changes nothing", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const writes = f.writes.length,
    before = structuredClone(f.host.config);
  // Admission reads the dispatch-time scopes; the live check runs only at publication.
  const revoked = operatorContext(f.api, ["operator.admin"], () => {
    throw new Error("Gateway requester authority changed");
  });
  const result = await f.service.stores_change(
    {
      requestId: randomUUID(),
      expectedRevision: (await f.snapshot()).revision,
      agent: "main",
      change: { kind: "share_existing", label: "A", agents: ["research"] },
    },
    revoked,
  );
  expect(result.outcome).not.toBe("applied");
  expect(f.writes).toHaveLength(writes);
  expect(f.host.config).toStrictEqual(before);
  // The refused request does not block a current administrator.
  const next = await f.share("main", ["research"], "A");
  expect(next.result.outcome, next.result.message).toBe("applied");
});

it("validation, stale revisions and non-admin callers never partially apply", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const stale = (await f.snapshot()).revision;
  expect((await f.share("research", ["main"])).result.outcome, "unprovisioned source").toBe(
    "invalid",
  );
  expect(await f.outcome("main", { kind: "use_named", store: "missing" })).toBe("invalid");
  expect(await f.outcome("main", { kind: "use_own" })).toBe("invalid");
  expect((await f.share("main", ["ghost"])).result.outcome).toBe("invalid");
  expect((await f.share("main", ["research"])).result.outcome).toBe("applied");
  expect(await f.outcome("ops", { kind: "use_named", store: "team" }, stale)).toBe("conflict");
  const denied = await f.service.stores_change(
    {
      requestId: randomUUID(),
      expectedRevision: (await f.snapshot()).revision,
      agent: "ops",
      change: { kind: "use_named", store: "team" },
    },
    operatorContext(f.api, ["operator.write"]),
  );
  expect(denied.outcome).toBe("forbidden");
  expect((await f.service.stores_snapshot({}, f.reader)).canChange).toBe(false);
  await expect(f.service.stores_snapshot({}, f.as("main"))).rejects.toThrow(/operators/);
  expect(Object.keys(f.storesSection())).toStrictEqual(["team"]);
});

it("a concurrent config edit inside the write is a conflict, not an overwrite", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async (params) => {
    f.host.config = structuredClone(f.host.config);
    f.host.config.plugins.entries.knowledge.config.stores = { other: { agents: ["ops"] } };
    return original(params);
  };
  const { result } = await f.share("main", ["research"]);
  expect(result.outcome).toBe("conflict");
  expect(f.host.config.plugins.entries.knowledge.config.stores).toStrictEqual({
    other: { agents: ["ops"] },
  });
});

it("repeated request IDs replay the outcome; reuse for another change is rejected", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const { input, result } = await f.share("main", ["research"]);
  expect(result.outcome).toBe("applied");
  expect((await f.service.stores_change(input, f.admin)).outcome).toBe("applied");
  expect(
    (await f.service.stores_change({ ...input, change: { kind: "use_own" } }, f.admin)).outcome,
  ).toBe("invalid");
  expect(
    (await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("applied");
  expect((await f.service.stores_change_status({ requestId: randomUUID() }, f.admin)).outcome).toBe(
    "not-applied",
  );
});

it("a crash between the config write and registry settlement reconciles to one outcome", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  // The write persists, then the process "dies" before the registry settles.
  f.api.runtime.config.mutateConfigFile = async (params) => {
    await original(params);
    throw new Error("process died");
  };
  const { input, result } = await f.share("main", ["research"]);
  f.api.runtime.config.mutateConfigFile = original;
  expect(result.outcome, "the persisted write is recognized as applied").toBe("applied");
  const restarted = createKnowledgeService(f.api);
  expect(
    (await restarted.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("applied");
  expect((await restarted.records({}, f.as("research"))).records.map((r) => r.title)).toStrictEqual(
    ["Seed"],
  );
});

it("a journaled change whose write never landed settles as not applied after restart", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  // Reads (which abort inside mutate) still work; any write fails before persisting.
  f.api.runtime.config.mutateConfigFile = async ({ mutate }) => {
    // The fixture's host config and an empty context stand in for the host's richer types.
    await mutate(
      structuredClone(f.host.config) as Parameters<Mutate>[0],
      {} as Parameters<Mutate>[1],
    );
    throw new Error("disk full");
  };
  const { input, result } = await f.share("main", ["research"]);
  expect(result.outcome, result.message).toBe("not-applied");
  expect(
    (await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("not-applied");
  expect(await f.titles("research")).toStrictEqual([]);
});

it("host publication lag after a save is not mistaken for an external edit", async () => {
  const f = await fixture({ lag: true });
  await f.save("main", "Seed");
  expect((await f.share("main", ["research"])).result.outcome).toBe("applied");
  // config.current() still shows the previous section until the host publishes.
  expect(await f.titles("research")).toStrictEqual(["Seed"]);
  f.publish();
  expect(await f.titles("research")).toStrictEqual(["Seed"]);
});

it("external configuration edits apply in-process; invalid membership makes affected agents unavailable", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  await f.share("main", ["research"]);
  f.host.config = structuredClone(f.host.config);
  f.storesSection().team!.agents.push("ops");
  expect(await f.titles("ops")).toStrictEqual(["Seed"]);
  f.host.config = structuredClone(f.host.config);
  f.storesSection().other = { agents: ["ops"] };
  await expect(f.titles("ops")).rejects.toThrow(/assignment is invalid/);
  const snap = await f.snapshot();
  expect(snap.agents.find((a) => a.id === "ops")!.issue).toMatch(/more than one store/);
  expect(await f.titles("main")).toStrictEqual(["Seed"]);
});

it("the cutover fences old-assignment access before applying and after", async () => {
  const f = await fixture();
  await f.save("research", "Research own");
  const stores = new Stores(
    f.api,
    parsePolicy({ operatorRead: true, writesEnabled: true }),
    () => {},
  );
  afterTest(() => stores.stop());
  const principal = (): Principal => ({ agentId: "research", scope: { visibility: "private" } });
  const opened = await stores.open(principal, { provision: false });
  expect(opened.kind).toBe("ready");
  if (opened.kind !== "ready") {
    throw new Error("expected a ready store");
  }
  opened.access.assertCurrent();
  let fencedDuringApply;
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.stores = { team: { agents: ["research"] } };
  await stores.cutover(["research"], async () => {
    try {
      opened.access.assertCurrent();
      fencedDuringApply = false;
    } catch {
      fencedDuringApply = true;
    }
    await stores.registry.call(
      "reconcile",
      JSON.stringify({ team: { agents: ["research"] } }),
      storesRevision({ team: { agents: ["research"] } }),
    );
  });
  expect(fencedDuringApply, "queued or in-flight work fails while the change applies").toBe(true);
  expect(() => opened.access.assertCurrent(), "old-assignment access never resumes").toThrow(
    /assignment changed/,
  );
  const next = await stores.open(principal, { provision: false });
  expect(next.kind, "the new assignment resolves to the named store").toBe("unprovisioned");
});

// Plugin reload starts the next generation as soon as stop/dispose resolve, so
// both must wait for the old generation's workers to exit. Worker handles are
// private; threadId becomes -1 once a worker has exited.
// Worker handles are private to their clients; tests read them only to observe exit.
const workerOf = (client: object) => Reflect.get(client, "worker") as Worker | undefined;

async function runningStores() {
  const f = await fixture();
  await f.save("main", "Seed");
  const stores = new Stores(f.api, parsePolicy({ writesEnabled: true }), () => {});
  afterTest(() => stores.stop());
  const opened = await stores.open(
    (): Principal => ({ agentId: "main", scope: { visibility: "private" } }),
    { provision: false },
  );
  if (opened.kind !== "ready") {
    throw new Error("expected a ready store");
  }
  await opened.runtime.enqueue(opened.access.assertCurrent, () =>
    opened.runtime.client.call("catalog", opened.access),
  );
  const workers = {
    storage: workerOf(opened.runtime.client)!,
    registry: workerOf(stores.registry)!,
  };
  expect(workers.storage.threadId).toBeGreaterThan(0);
  expect(workers.registry.threadId).toBeGreaterThan(0);
  return { f, stores, workers, opened };
}

it("service stop resolves only after the store and registry workers have exited", async () => {
  const { stores, workers } = await runningStores();
  await stores.stop();
  expect(workers.storage.threadId, "storage worker exited").toBe(-1);
  expect(workers.registry.threadId, "registry worker exited").toBe(-1);
});

it("disposal waits for workers and is final: later calls never start a worker", async () => {
  const { stores, workers } = await runningStores();
  await stores.dispose();
  expect(workers.storage.threadId).toBe(-1);
  expect(workers.registry.threadId).toBe(-1);
  await expect(stores.registry.call("snapshot")).rejects.toThrow(/registry stopped/);
  expect(workerOf(stores.registry), "no registry worker restarted").toBeUndefined();
});

it("the plugin instance disposes Knowledge through api.lifecycle.onDispose", async () => {
  const base = tempDirs.make("knowledge-stores-");
  const disposers: Array<() => Promise<void>> = [],
    services: any = [];
  const host = hostApi(base, {
    policy: { operatorRead: true, writesEnabled: true },
    extra: {
      registerService: (s: any) => services.push(s),
      lifecycle: {
        onDispose: (d: () => Promise<void>) => {
          disposers.push(d);
          return () => {};
        },
      },
    },
  });
  const service = createKnowledgeService(host.api);
  await services[0].start({});
  await service.save_page(
    { requestId: randomUUID(), title: "Seed", type: "note", body: "Seed body." },
    toolContext(host.api),
  );
  expect(disposers).toHaveLength(1);
  await services[0].stop();
  const [dispose] = disposers;
  if (!dispose) {
    throw new Error("expected a registered disposer");
  }
  await dispose();
  await expect(service.records({}, toolContext(host.api))).rejects.toThrow(/reloaded/);
});

it("restart failures carry a stable retryable code and their reason", async () => {
  const { stores, opened } = await runningStores();
  const restart = (reason: string) =>
    expect.objectContaining({ code: "UNAVAILABLE", retryable: true, reason });
  const { runtime, access } = opened;
  const inFlight = runtime.client.call("catalog", access);
  const closed = runtime.client.close();
  await expect(inFlight).rejects.toEqual(restart("storage-stopped"));
  await closed;
  await runtime.retire();
  await expect(
    runtime.enqueue(
      () => {},
      async () => {},
    ),
  ).rejects.toEqual(restart("runtime-retired"));
  await stores.dispose();
  let reloaded: unknown;
  try {
    stores.assertLive(stores.incarnation);
  } catch (error) {
    reloaded = error;
  }
  expect(reloaded).toEqual(restart("service-reloaded"));
  await expect(stores.registry.call("snapshot")).rejects.toEqual(restart("registry-stopped"));
});

it("operator proxy is operator-only and validates inner operations", async () => {
  const f = await fixture();
  await f.save("research", "Visible to operator");
  const rows = (await query(f, "records")) as Output<"records">;
  expect(rows.records.map((r) => r.title)).toStrictEqual(["Visible to operator"]);
  expect(
    (await f.service.records({}, f.reader)).total,
    "default operator view is the default agent",
  ).toBe(0);
  await expect(
    f.service.agent_query({ agent: "research", operation: "records", input: {} }, f.as("main")),
  ).rejects.toThrow(/operator/);
  for (const operation of ["save_page", "stores_snapshot"]) {
    await expect(query(f, operation)).rejects.toThrow(/Unknown query/);
  }
  await expect(
    f.service.agent_query({ agent: "ghost", operation: "records", input: {} }, f.reader),
  ).rejects.toThrow(/Unknown agent/);
  await expect(query(f, "records", { bogus: 1 })).rejects.toThrow(/Invalid input/);
});

it("recovery keeps a shared store bound to its data even when other edits conflict", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async (params) => {
    await original(params);
    // Before settlement, someone else edits another part of the stores section.
    f.host.config = structuredClone(f.host.config);
    f.storesSection().other = { agents: ["ops"] };
    throw new Error("process died");
  };
  const { result } = await f.share("main", ["research"]);
  f.api.runtime.config.mutateConfigFile = original;
  expect(result.outcome).toBe("conflict");
  expect(
    (await createKnowledgeService(f.api).records({}, f.as("research"))).records.map((x) => x.title),
  ).toStrictEqual(["Seed"]);
  expect((await f.storesDir()).length, "no empty replacement store").toBe(1);
});

it("an interrupted sentinel write is completed; a sentinel naming another registry is refused", async () => {
  const f = await fixture();
  await f.save("main", "Kept");
  const sentinel = path.join(f.stateRoot, "registry.id");
  const id = await readFile(sentinel, "utf8");
  // Exclusive create succeeded, then the process died before writing the ID.
  await writeFile(sentinel, "");
  const restarted = createKnowledgeService(f.api);
  expect((await restarted.records({}, f.as("main"))).total).toBe(1);
  expect(await readFile(sentinel, "utf8")).toBe(id);
  await writeFile(sentinel, "another-registry\n");
  await expect(createKnowledgeService(f.api).records({}, f.as("main"))).rejects.toThrow(/registry/);
});

it("several agents without a default: operators must choose; tools are unaffected", async () => {
  const f = await fixture();
  // No agent entry is marked default, as on installs with several agents.
  for (const agent of f.host.config.agents.list) {
    delete agent.default;
  }
  await f.save("research", "Research note");
  const snap = await f.snapshot();
  expect(snap.defaultAgent).toBe(undefined);
  await expect(f.service.status({}, f.reader)).rejects.toThrow(/choose which agent/);
  expect(((await query(f, "records")) as Output<"records">).total).toBe(1);
  expect((await f.service.status({}, f.as("main"))).store).toBe("unprovisioned");
});
