import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../../api.js";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import type { ActionRunner, ScheduledTask } from "./types.js";

const logger: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} } as PluginLogger;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = Date.now();
  return {
    id: "s1",
    uid: "1749",
    title: "刷新A",
    schedule: { kind: "interval", everyMinutes: 5 },
    tz: "Asia/Shanghai",
    action: { tool: "crawl_refresh_create", params: { links: ["https://a.com/1"] } },
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    mercureTopic: "1749",
    delivery: {},
    enabled: true,
    nextRunAt: now - 1, // due
    failCount: 0,
    createdAt: now,
    ...overrides,
  };
}

describe("Scheduler.tick", () => {
  it("runs a due task and reschedules nextRunAt forward", async () => {
    const store = new ScheduleStore();
    store.add(task());
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true, note: "uuid" });
    const sched = new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger });

    const now = Date.now();
    await sched.tick(now);

    expect(runner).toHaveBeenCalledOnce();
    const updated = store.get("s1")!;
    expect(updated.nextRunAt).toBe(now + 5 * 60_000);
    expect(updated.lastRunAt).toBe(now);
    expect(updated.enabled).toBe(true);
  });

  it("does not run a task that is not yet due", async () => {
    const store = new ScheduleStore();
    store.add(task({ nextRunAt: Date.now() + 3_600_000 }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    expect(runner).not.toHaveBeenCalled();
  });

  it("skips disabled tasks", async () => {
    const store = new ScheduleStore();
    store.add(task({ enabled: false }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    expect(runner).not.toHaveBeenCalled();
  });

  it("counts failures and auto-disables after 5", async () => {
    const store = new ScheduleStore();
    store.add(task({ failCount: 4 }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: false, note: "boom" });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    const updated = store.get("s1")!;
    expect(updated.failCount).toBe(5);
    expect(updated.enabled).toBe(false);
  });

  it("still reschedules when the runner throws", async () => {
    const store = new ScheduleStore();
    store.add(task());
    const runner: ActionRunner = vi.fn().mockRejectedValue(new Error("x"));
    const now = Date.now();
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick(now);
    const updated = store.get("s1")!;
    expect(updated.nextRunAt).toBe(now + 5 * 60_000);
    expect(updated.failCount).toBe(1);
  });
});
