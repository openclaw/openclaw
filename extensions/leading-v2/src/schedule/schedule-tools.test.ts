import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ScheduleStore } from "./schedule-store.js";
import {
  createScheduleCreateToolFactory,
  createScheduleDeleteToolFactory,
  createScheduleListToolFactory,
  createScheduleToggleToolFactory,
} from "./schedule-tools.js";

const api = { logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as OpenClawPluginApi;

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

const ctx = {
  agentId: "rabbitmq-1749",
  sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
};

afterEach(() => vi.clearAllMocks());

describe("gating", () => {
  it("hides from non-rabbitmq agents", () => {
    const store = new ScheduleStore();
    expect(createScheduleCreateToolFactory(api, store)({ agentId: "telegram-1" })).toBeNull();
    expect(createScheduleListToolFactory(api, store)({ agentId: "x" })).toBeNull();
  });
});

describe("schedule_create", () => {
  it("creates a daily crawl_refresh task with links", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c1", {
        title: "每天刷新A",
        kind: "daily",
        time: "09:00",
        action: "crawl_refresh",
        params: { links: ["https://a.com/1", "https://a.com/2"] },
      }),
    );
    expect(res).toMatchObject({ success: true, created: true, title: "每天刷新A" });
    expect(res.schedule).toBe("每天 09:00");
    const tasks = store.forUser("1749");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      uid: "1749",
      enabled: true,
      action: { tool: "crawl_refresh_create" },
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    });
    expect((tasks[0].action.params as Record<string, unknown>).links).toEqual([
      "https://a.com/1",
      "https://a.com/2",
    ]);
  });

  it("rejects daily without a valid time", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c2", { title: "x", kind: "daily", action: "crawl_refresh", params: { links: ["https://a/1"] } }),
    );
    expect(res.success).toBe(false);
    expect(store.forUser("1749")).toHaveLength(0);
  });

  it("rejects crawl_refresh without links or feeds", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c3", { title: "x", kind: "interval", everyMinutes: 5, action: "crawl_refresh" }),
    );
    expect(res.success).toBe(false);
  });

  it("rejects weekly with a bad weekday", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c4", {
        title: "x",
        kind: "weekly",
        weekday: 9,
        time: "09:00",
        action: "crawl_refresh",
        params: { links: ["https://a/1"] },
      }),
    );
    expect(res.success).toBe(false);
  });

  it("rejects crawl_refresh with garbage links (the '[]' string)", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c5", {
        title: "x",
        kind: "interval",
        everyMinutes: 2,
        action: "crawl_refresh",
        params: { links: "[]" },
      }),
    );
    expect(res.success).toBe(false);
    expect(store.forUser("1749")).toHaveLength(0);
  });

  it("creates an agent_prompt task from an instruction", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c6", {
        title: "每天道早安",
        kind: "daily",
        time: "08:00",
        action: "agent_prompt",
        params: { instruction: "跟用户道早安并提醒今天的待办" },
      }),
    );
    expect(res).toMatchObject({ success: true, created: true, title: "每天道早安" });
    const task = store.forUser("1749")[0];
    expect(task.action.tool).toBe("agent_prompt");
    expect((task.action.params as Record<string, unknown>).instruction).toBe("跟用户道早安并提醒今天的待办");
  });

  it("rejects agent_prompt without an instruction", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c7", { title: "x", kind: "daily", time: "08:00", action: "agent_prompt", params: {} }),
    );
    expect(res.success).toBe(false);
    expect(store.forUser("1749")).toHaveLength(0);
  });

  it("rejects an unknown action", async () => {
    const store = new ScheduleStore();
    const tool = createScheduleCreateToolFactory(api, store)(ctx)!;
    const res = parse(
      await tool.execute("c8", { title: "x", kind: "daily", time: "08:00", action: "nope", params: {} }),
    );
    expect(res.success).toBe(false);
  });
});

describe("schedule_list / delete / toggle", () => {
  function seed() {
    const store = new ScheduleStore();
    const create = createScheduleCreateToolFactory(api, store)(ctx)!;
    return { store, create };
  }

  it("lists with 1-based index and toggles/deletes by it", async () => {
    const { store, create } = seed();
    await create.execute("a", {
      title: "任务一",
      kind: "interval",
      everyMinutes: 10,
      action: "crawl_refresh",
      params: { links: ["https://a/1"] },
    });

    const list = createScheduleListToolFactory(api, store)(ctx)!;
    const listed = parse(await list.execute());
    expect(listed.total).toBe(1);
    expect((listed.list as Array<Record<string, unknown>>)[0]).toMatchObject({ index: 1, title: "任务一", enabled: true });

    const toggle = createScheduleToggleToolFactory(api, store)(ctx)!;
    expect(parse(await toggle.execute("t", { index: 1, enabled: false })).enabled).toBe(false);
    expect(store.forUser("1749")[0].enabled).toBe(false);

    const del = createScheduleDeleteToolFactory(api, store)(ctx)!;
    expect(parse(await del.execute("d", { index: 1 })).deleted).toBe(true);
    expect(store.forUser("1749")).toHaveLength(0);
  });

  it("delete with a bad index errors", async () => {
    const { store } = seed();
    const del = createScheduleDeleteToolFactory(api, store)(ctx)!;
    expect(parse(await del.execute("d", { index: 99 })).success).toBe(false);
  });
});
