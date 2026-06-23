import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../../../api.js";
import type { ScheduledTask } from "../types.js";
import { agentPromptAction } from "./agent-prompt-action.js";
import type { ActionRunnerDeps } from "./types.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as PluginLogger;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    uid: "1749",
    title: "每天道早安",
    schedule: { kind: "daily", time: "08:00" },
    tz: "Asia/Shanghai",
    action: { tool: "agent_prompt", params: { instruction: "跟用户道早安" } },
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    mercureTopic: "lobster/user/1749",
    delivery: { channel: "webchat" },
    enabled: true,
    nextRunAt: 0,
    failCount: 0,
    createdAt: 0,
    ...overrides,
  };
}

function makeSubagent(assistantText: string, status: "ok" | "error" | "timeout" = "ok") {
  return {
    run: vi.fn(async () => ({ runId: "r1" })),
    waitForRun: vi.fn(async () => ({ status, error: status === "ok" ? undefined : "boom" })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: assistantText }],
    })),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
  } as unknown as NonNullable<ActionRunnerDeps["subagent"]>;
}

function deps(over: Partial<ActionRunnerDeps> = {}): ActionRunnerDeps {
  return {
    config: {} as ActionRunnerDeps["config"],
    resolver: {} as ActionRunnerDeps["resolver"],
    registry: {} as ActionRunnerDeps["registry"],
    deliver: vi.fn(async () => true),
    logger,
    ...over,
  };
}

describe("agentPromptAction.validate", () => {
  it("accepts a non-empty instruction and trims it", () => {
    const r = agentPromptAction.validate({ instruction: "  早安  " });
    expect(r).toEqual({ ok: true, params: { instruction: "早安" } });
  });

  it("rejects a missing/blank instruction", () => {
    expect(agentPromptAction.validate({}).ok).toBe(false);
    expect(agentPromptAction.validate({ instruction: "   " }).ok).toBe(false);
  });
});

describe("agentPromptAction runner", () => {
  it("runs in a derived ':sched' session and delivers the assistant reply", async () => {
    const subagent = makeSubagent("早安！今天有 3 件待办。");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));

    const res = await runner(task());

    expect(res.ok).toBe(true);
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1:sched", deliver: false }),
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ category: "scheduled", body: "早安！今天有 3 件待办。", title: "每天道早安" }),
      expect.objectContaining({ mercureTopic: "lobster/user/1749", sessionKey: task().sessionKey }),
    );
  });

  it("fails (no delivery) when the subagent runtime is unavailable", async () => {
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent: undefined, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails on subagent timeout without delivering", async () => {
    const subagent = makeSubagent("", "timeout");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails when the assistant reply is empty", async () => {
    const subagent = makeSubagent("   ");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
