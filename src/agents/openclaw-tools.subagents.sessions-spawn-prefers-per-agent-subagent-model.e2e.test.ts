import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

describe("openclaw-tools: subagents", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("sessions_spawn prefers per-agent subagent model over defaults", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { model: "minimax/MiniMax-M2.1" } },
        list: [{ id: "research", subagents: { model: "opencode/claude" } }],
      },
    };
    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-agent-model", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:research:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-agent-model", {
      task: "do thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find((call) => call.method === "sessions.patch");
    expect(patchCall?.params).toMatchObject({
      model: "opencode/claude",
    });
  });
  it("sessions_spawn skips invalid model overrides and continues", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        throw new Error("invalid model: bad-model");
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        return {
          runId,
          status: "accepted",
          acceptedAt: 4000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call4", {
      task: "do thing",
      runTimeoutSeconds: 1,
      model: "bad-model",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: false,
    });
    expect(String((result.details as { warning?: string }).warning ?? "")).toContain(
      "invalid model",
    );
    expect(calls.some((call) => call.method === "agent")).toBe(true);
  });
  it("sessions_spawn supports legacy timeoutSeconds alias", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    let spawnedTimeout: number | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { timeout?: number } | undefined;
        spawnedTimeout = params?.timeout;
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call5", {
      task: "do thing",
      timeoutSeconds: 2,
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(spawnedTimeout).toBe(2);
  });

  it("sessions_spawn uses global default runTimeoutSeconds when param omitted", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { runTimeoutSeconds: 7 } } },
    };
    let spawnedTimeout: number | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { timeout?: number } | undefined;
        spawnedTimeout = params?.timeout;
        return { runId: "run-global-timeout", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({ agentSessionKey: "main", agentChannel: "discord" }).find(
      (candidate) => candidate.name === "sessions_spawn",
    );
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-global-timeout", {
      task: "do thing",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(spawnedTimeout).toBe(7);
  });

  it("sessions_spawn prefers per-agent runTimeoutSeconds over global default", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { runTimeoutSeconds: 7 } },
        list: [{ id: "research", subagents: { runTimeoutSeconds: 3 } }],
      },
    };
    let spawnedTimeout: number | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { timeout?: number } | undefined;
        spawnedTimeout = params?.timeout;
        return { runId: "run-agent-timeout", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:research:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-agent-timeout", {
      task: "do thing",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(spawnedTimeout).toBe(3);
  });

  it("sessions_spawn explicit runTimeoutSeconds overrides config defaults", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { runTimeoutSeconds: 7 } },
        list: [{ id: "research", subagents: { runTimeoutSeconds: 3 } }],
      },
    };
    let spawnedTimeout: number | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { timeout?: number } | undefined;
        spawnedTimeout = params?.timeout;
        return { runId: "run-explicit-timeout", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:research:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-explicit-timeout", {
      task: "do thing",
      runTimeoutSeconds: 11,
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(spawnedTimeout).toBe(11);
  });

  it("sessions_spawn explicit 0 disables timeout even when config sets one", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { runTimeoutSeconds: 7 } } },
    };
    let spawnedTimeout: number | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { timeout?: number } | undefined;
        spawnedTimeout = params?.timeout;
        return { runId: "run-explicit-zero", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({ agentSessionKey: "main", agentChannel: "discord" }).find(
      (candidate) => candidate.name === "sessions_spawn",
    );
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-explicit-zero", {
      task: "do thing",
      runTimeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(spawnedTimeout).toBeUndefined();
  });
});
