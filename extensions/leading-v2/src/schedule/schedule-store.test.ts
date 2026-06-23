import { describe, expect, it } from "vitest";
import { ScheduleStore } from "./schedule-store.js";
import type { ScheduledTask } from "./types.js";

function task(id: string, uid = "1749"): ScheduledTask {
  return {
    id,
    uid,
    title: `t-${id}`,
    schedule: { kind: "interval", everyMinutes: 5 },
    tz: "Asia/Shanghai",
    action: { tool: "agent_prompt", params: { instruction: "hi" } },
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    mercureTopic: "lobster/user/1749",
    delivery: {},
    enabled: true,
    nextRunAt: 0,
    failCount: 0,
    createdAt: 0,
  };
}

describe("ScheduleStore (no-db / in-memory mode)", () => {
  it("add/get/forUser/remove operate on the in-memory map", () => {
    const store = new ScheduleStore();
    store.add(task("a"));
    store.add(task("b", "2005"));
    expect(store.get("a")?.title).toBe("t-a");
    expect(store.forUser("1749").map((t) => t.id)).toEqual(["a"]);
    expect(store.remove("a")).toBe(true);
    expect(store.get("a")).toBeUndefined();
  });

  it("reload() is a no-op without a db and does NOT wipe in-memory tasks", async () => {
    const store = new ScheduleStore();
    store.add(task("keep"));
    await store.reload();
    expect(store.get("keep")?.id).toBe("keep");
  });

  it("update() merges a patch and recomputes due()", () => {
    const store = new ScheduleStore();
    store.add(task("a"));
    store.update("a", { enabled: false });
    expect(store.due(Date.now())).toHaveLength(0);
    store.update("a", { enabled: true, nextRunAt: Date.now() - 1 });
    expect(store.due(Date.now()).map((t) => t.id)).toEqual(["a"]);
  });
});
