import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  getCallGatewayMock,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn model + thinking)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
  });

  it("sessions_spawn applies a model to the child session", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        return {
          runId,
          status: "accepted",
          acceptedAt: 3000 + agentCallCount,
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
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call3", {
      task: "do thing",
      runTimeoutSeconds: 1,
      model: "claude-haiku-4-5",
      cleanup: "keep",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchIndex = calls.findIndex((call) => call.method === "sessions.patch");
    const agentIndex = calls.findIndex((call) => call.method === "agent");
    expect(patchIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(-1);
    expect(patchIndex).toBeLessThan(agentIndex);
    const patchCall = calls.find(
      (call) => call.method === "sessions.patch" && (call.params as { model?: string })?.model,
    );
    expect(patchCall?.params).toMatchObject({
      key: expect.stringContaining("subagent:"),
      model: "claude-haiku-4-5",
    });
  });

  it("sessions_spawn forwards thinking overrides to the agent run", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-thinking", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-thinking", {
      task: "do thing",
      thinking: "high",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });

    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall?.params).toMatchObject({
      thinking: "high",
    });
  });

  it("sessions_spawn rejects invalid thinking levels", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      calls.push(request);
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-thinking-invalid", {
      task: "do thing",
      thinking: "banana",
    });
    expect(result.details).toMatchObject({
      status: "error",
    });
    expect(String(result.details?.error)).toMatch(/Invalid thinking level/i);
    expect(calls).toHaveLength(0);
  });

  it("sessions_spawn applies default subagent model from defaults config", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.1" } } },
    });
    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-default-model", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-default-model", {
      task: "do thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find(
      (call) => call.method === "sessions.patch" && (call.params as { model?: string })?.model,
    );
    expect(patchCall?.params).toMatchObject({
      model: "minimax/MiniMax-M2.1",
    });
  });

  it("sessions_spawn falls back to runtime default model when no model config is set", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-runtime-default-model", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-runtime-default-model", {
      task: "do thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find(
      (call) => call.method === "sessions.patch" && (call.params as { model?: string })?.model,
    );
    expect(patchCall?.params).toMatchObject({
      model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
    });
  });

  it("sessions_spawn prefers per-agent subagent model over defaults", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: { subagents: { model: "minimax/MiniMax-M2.1" } },
        list: [{ id: "research", subagents: { model: "opencode/claude" } }],
      },
    });
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

    const patchCall = calls.find(
      (call) => call.method === "sessions.patch" && (call.params as { model?: string })?.model,
    );
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
        const params = request.params as { model?: unknown } | undefined;
        if (typeof params?.model === "string" && params.model.trim()) {
          throw new Error("invalid model: bad-model");
        }
        return { ok: true };
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
});
