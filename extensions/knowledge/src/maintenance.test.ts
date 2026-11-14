import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { contract } from "./contract.js";
import { Maintenance } from "./maintenance.js";
import { RegistryClient } from "./registry-client.js";
import { createKnowledgeService } from "./service.js";
import { parsePolicy } from "./stores-config.js";
import { Stores } from "./stores.js";
import {
  adopt,
  createVault,
  hostApi,
  operatorContext,
  toolContext,
  afterTest,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

/** Host-like service scheduler with a manual clock. */
function fakeScheduler(start: any) {
  const jobs = new Map(),
    scheduler = {
      version: 1,
      clock: start,
      signal: new AbortController().signal,
      now: () => scheduler.clock,
      schedule(job: any) {
        jobs.set(job.id, { ...job, at: job.atMs ?? scheduler.clock + job.delayMs });
        return {
          cancel() {
            jobs.delete(job.id);
          },
          async stop() {},
        };
      },
      async fire(id: any) {
        const job = jobs.get(id);
        expect(job, `job ${id} is scheduled`).toBeTruthy();
        jobs.delete(id);
        scheduler.clock = Math.max(scheduler.clock, job.at);
        await job.run();
      },
      jobs,
    };
  return scheduler;
}

// Stores: main's own, a named team store for ops, and an unprovisioned idle agent.
async function fixture(maintenance: object = {}, writesEnabled = true) {
  const base = tempDirs.make("knowledge-maintenance-");
  const host = hostApi(base, {
    agents: ["main", "ops", "idle"],
    stores: { team: { label: "Team", agents: ["ops"] } },
    policy: {
      writesEnabled,
      operatorRead: true,
      maintenance: { schedule: "0 * * * *", timezone: "UTC", ...maintenance },
    },
  });
  const own = await createVault(base, { name: "own" }),
    team = await createVault(base, { name: "team" });
  adopt(host.stateRoot, "agent:main", own.config);
  adopt(host.stateRoot, "named:team", team.config, "Team");
  const lifecycles: any = [];
  host.api.registerService = (s) => lifecycles.push(s);
  host.api.logger = { info() {}, warn() {}, error() {} };
  const boot = async (scheduler: any, options = {}) => {
    lifecycles.length = 0;
    const service = createKnowledgeService(host.api);
    await lifecycles[0].start({ scheduler, ...options });
    afterTest(() => lifecycles[0]?.stop());
    return service;
  };
  return { host, boot, lifecycles };
}

const remember = (service: any, context: any, text: any) =>
  service.remember(
    {
      requestId: randomUUID(),
      attribution: "test",
      excerpt: `User: ${text}`,
      items: [{ text, kind: "fact", infer_subject: false }],
    },
    context,
  );
const page = (service: any, context: any, title: any, type = "company") =>
  service.save_page({ requestId: randomUUID(), title, type, body: "Page.\n" }, context);

it("stopping the service ends maintenance: a pass in flight neither re-arms nor records state afterwards", async () => {
  const f = await fixture(),
    scheduler = fakeScheduler(Date.parse("2026-10-20T10:20:00Z")),
    service = await f.boot(scheduler);
  await remember(service, toolContext(f.host.api, "main"), "Atlas Labs moved its launch to March.");
  const warnings: string[] = [];
  f.host.api.logger = { info() {}, warn: (m: string) => warnings.push(m), error() {} };
  const pass = scheduler.fire("knowledge-maintenance");
  await f.lifecycles[0].stop();
  await pass;
  expect(scheduler.jobs.size, "no job is armed on the stopped scheduler").toBe(0);
  expect(
    warnings.filter((m) => m.includes("schedule was not recorded")),
    "the stopped service records no maintenance state",
  ).toStrictEqual([]);
});

it("stopping while a pass is paused settles maintenance before closing the registry", async () => {
  // Passthrough spies record each call's receiver, result and global call order.
  const callSpy = vi.spyOn(RegistryClient.prototype, "call"),
    closeSpy = vi.spyOn(RegistryClient.prototype, "close"),
    storesStopSpy = vi.spyOn(Stores.prototype, "stop"),
    maintenanceStopSpy = vi.spyOn(Maintenance.prototype, "stop"),
    releaseSpy = vi.spyOn(Stores.prototype, "releaseIdle");
  afterTest(() => {
    for (const spy of [callSpy, closeSpy, storesStopSpy, maintenanceStopSpy, releaseSpy]) {
      spy.mockRestore();
    }
  });
  const f = await fixture(),
    scheduler = fakeScheduler(Date.parse("2026-10-22T10:20:00Z"));
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    paused = new Promise<void>((resolve) => {
      release = resolve;
    });
  // A failed assertion must not leave the pass, and so its service stop, paused.
  afterTest(() => release());
  const pauseSettled = vi.fn();
  const service = await f.boot(scheduler);
  await remember(service, toolContext(f.host.api, "main"), "I prefer short replies.");
  // The pass pauses after relink, before it records its state.
  releaseSpy.mockImplementationOnce(async () => {
    entered();
    await paused;
    pauseSettled();
  });
  const pass = scheduler.fire("knowledge-maintenance");
  await reached;
  const stopped = f.lifecycles[0].stop();
  expect(maintenanceStopSpy, "stop asks maintenance to settle").toHaveBeenCalledOnce();
  expect(
    storesStopSpy.mock.calls.map(([gate]) => gate),
    "the registry closes only after maintenance settles",
  ).toStrictEqual(maintenanceStopSpy.mock.results.map((result) => result.value));
  expect(closeSpy, "nothing closes while the pass is paused").not.toHaveBeenCalled();
  release();
  await stopped;
  await pass;
  expect(closeSpy).toHaveBeenCalledOnce();
  const [closedAt] = closeSpy.mock.invocationCallOrder,
    [closed] = closeSpy.mock.contexts;
  expect(pauseSettled.mock.invocationCallOrder[0]).toBeLessThan(closedAt!);
  callSpy.mock.contexts.forEach((registry, index) => {
    if (registry === closed) {
      expect(callSpy.mock.invocationCallOrder[index], "no registry call after close").toBeLessThan(
        closedAt!,
      );
    }
  });
  for (const registry of new Set<RegistryClient>(callSpy.mock.contexts as RegistryClient[])) {
    expect(Reflect.get(registry, "worker"), "no registry worker after stop").toBeUndefined();
  }
});

it("a scheduled pass links across every store and partition, skips unprovisioned stores, repeats as a no-op, and catches up after a miss", async () => {
  const f = await fixture(),
    start = Date.parse("2026-10-20T10:20:00Z");
  const scheduler = fakeScheduler(start),
    service = await f.boot(scheduler);
  expect(scheduler.jobs.get("knowledge-maintenance").at).toBe(Date.parse("2026-10-20T11:00:00Z"));

  const main = toolContext(f.host.api, "main"),
    ops = toolContext(f.host.api, "ops");
  const group = toolContext(f.host.api, "main", {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: randomUUID(),
  });
  const a = (await remember(service, main, "Atlas Labs moved its launch to March.")).items[0].id;
  const b = (await remember(service, ops, "Nimbus Works hired a CFO.")).items[0].id;
  const c = (await remember(service, group, "Atlas Labs joined the group call.")).items[0].id;
  const atlas = await page(service, main, "Atlas Labs"),
    nimbus = await page(service, ops, "Nimbus Works");
  // A page in another store or partition is never a target.
  await page(service, ops, "Atlas Labs");
  const groupAtlas = await page(service, group, "Atlas Labs");

  await scheduler.fire("knowledge-maintenance");
  const status = await service.maintenance_status({}, operatorContext(f.host.api));
  expect(Check(contract.operations.maintenance_status.output, status)).toBeTruthy();
  const byBinding = Object.fromEntries(status.lastRun!.vaults.map((v) => [v.binding, v]));
  expect(Object.keys(byBinding).toSorted(defaultOrder)).toStrictEqual([
    "agent:idle",
    "agent:main",
    "named:team",
  ]);
  expect([
    byBinding["agent:main"]!.outcome,
    byBinding["agent:main"]!.partitions,
    byBinding["agent:main"]!.linked,
  ]).toStrictEqual(["ok", 2, 2]);
  expect([
    byBinding["named:team"]!.outcome,
    byBinding["named:team"]!.linked,
    byBinding["named:team"]!.label,
  ]).toStrictEqual(["ok", 1, "Team"]);
  expect(byBinding["agent:idle"]!.outcome).toBe("skipped");
  expect(status.lastRun!.trigger).toBe("scheduled");
  expect(status.lastRun!.slot).toBe("2026-10-20T11:00:00.000Z");
  expect(status.lastRun!.linked).toBe(3);
  expect(status.nextRunAt).toBe("2026-10-20T12:00:00.000Z");
  const entities = async (ctx: any, id: any) =>
    (await service.record({ id, includeMetadata: true }, ctx)).record!.metadata!.entities;
  expect(await entities(main, a)).toStrictEqual([atlas.id]);
  expect(await entities(ops, b)).toStrictEqual([nimbus.id]);
  expect(
    await entities(group, c),
    "Conversation claims link only within their own partition",
  ).toStrictEqual([groupAtlas.id]);
  const history = await service.history({ id: a }, main);
  expect(JSON.stringify(history)).toMatch(/maintenance/);
  await expect(service.maintenance_status({}, main)).rejects.toThrow(/operators only/);

  await scheduler.fire("knowledge-maintenance");
  const again = await service.maintenance_status({}, operatorContext(f.host.api));
  expect(again.lastRun!.linked, "A repeat pass links nothing new").toBe(0);
  expect(again.lastRun!.slot).toBe("2026-10-20T12:00:00.000Z");

  // The Gateway is down across the 13:00 slot; the next start catches up once.
  await f.lifecycles[0].stop();
  const later = fakeScheduler(Date.parse("2026-10-20T13:40:00Z")),
    restarted = await f.boot(later);
  const catchUp = later.jobs.get("knowledge-maintenance");
  expect(catchUp.at).toBe(later.clock + 60_000);
  await later.fire("knowledge-maintenance");
  const caught = await restarted.maintenance_status({}, operatorContext(f.host.api));
  expect([caught.lastRun!.trigger, caught.lastRun!.slot, caught.nextRunAt]).toStrictEqual([
    "catch-up",
    "2026-10-20T13:00:00.000Z",
    "2026-10-20T14:00:00.000Z",
  ]);
});

it("disabled maintenance, invalid schedules and write-disabled installs schedule nothing", async () => {
  for (const [maintenance, writesEnabled, expected] of [
    [{ enabled: false }, true, /^$/],
    [{ schedule: "not a cron" }, true, /five fields/],
    [{}, false, /^$/],
  ] as const) {
    const f = await fixture(maintenance, writesEnabled),
      scheduler = fakeScheduler(Date.now()),
      service = await f.boot(scheduler);
    expect(scheduler.jobs.size).toBe(0);
    const status = await service.maintenance_status({}, operatorContext(f.host.api));
    expect(status.nextRunAt).toBe(null);
    expect(status.configError ?? "").toMatch(expected);
  }
});

it("a pass leaves claims it cannot link for the review scribe and never reaches the automation scheduler", async () => {
  const f = await fixture(),
    host = f.host,
    scheduler = fakeScheduler(Date.parse("2026-10-22T10:20:00Z"));
  const getCron = vi.fn();
  const service = await f.boot(scheduler, { getCron });
  const main = toolContext(host.api, "main");
  await remember(service, main, "Atlas Labs moved its launch to March.");
  const left = (await remember(service, main, "I prefer short replies.")).items[0].id;
  await page(service, main, "Atlas Labs");
  await scheduler.fire("knowledge-maintenance");
  const status = await service.maintenance_status({}, operatorContext(host.api));
  expect(Check(contract.operations.maintenance_status.output, status)).toBeTruthy();
  expect(status.lastRun!.linked, "relink links Atlas").toBe(1);
  expect(Object.keys(status.lastRun!), "a pass records no review").not.toContain("review");
  expect(Object.keys(status), "status names no review automation").not.toContain("reviewJobId");
  expect(getCron, "maintenance never looks up or queues an automation").not.toHaveBeenCalled();
  const record = (await service.record({ id: left, includeMetadata: true }, main)).record!;
  expect(record.metadata!.entities ?? [], "the preference stays unlinked").toStrictEqual([]);
});

it("a maintenance reviewJobId is not a configuration key", () => {
  expect(() => parsePolicy({ maintenance: { reviewJobId: "review-job" } })).toThrow(
    /configuration is invalid/,
  );
});
