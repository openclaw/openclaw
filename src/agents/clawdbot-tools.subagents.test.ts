import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: ReturnType<
  typeof import("../config/config.js")["loadConfig"]
> = {
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

import { emitAgentEvent } from "../infra/agent-events.js";
import { createClawdbotTools } from "./clawdbot-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

describe("subagents", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("sessions_spawn announces back to the requester group channel", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    let deletedKey: string | undefined;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];
    const sessionLastAssistantText = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as {
          message?: string;
          sessionKey?: string;
          channel?: string;
          timeout?: number;
        };
        const message = params?.message ?? "";
        const sessionKey = params?.sessionKey ?? "";
        if (message === "Sub-agent announce step.") {
          sessionLastAssistantText.set(sessionKey, "announce now");
        } else {
          childRunId = runId;
          childSessionKey = sessionKey;
          sessionLastAssistantText.set(sessionKey, "result");
          expect(params?.channel).toBe("discord");
          expect(params?.timeout).toBe(1);
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 1000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as
          | { runId?: string; timeoutMs?: number }
          | undefined;
        waitCalls.push(params ?? {});
        const status = params?.runId === childRunId ? "timeout" : "ok";
        return { runId: params?.runId ?? "run-1", status };
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        const text =
          sessionLastAssistantText.get(params?.sessionKey ?? "") ?? "";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      if (request.method === "sessions.delete") {
        const params = request.params as { key?: string } | undefined;
        deletedKey = params?.key;
        return { ok: true };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call1", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    if (!childRunId) throw new Error("missing child runId");
    emitAgentEvent({
      runId: childRunId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1234,
        endedAt: 2345,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    const second = agentCalls[1]?.params as
      | { channel?: string; deliver?: boolean; lane?: string }
      | undefined;
    expect(second?.lane).toBe("nested");
    expect(second?.deliver).toBe(false);
    expect(second?.channel).toBe("webchat");

    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:req");
    expect(sendParams.message ?? "").toContain("announce now");
    expect(sendParams.message ?? "").toContain("Stats:");
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn announces via agent.wait when lifecycle events are missing", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    let deletedKey: string | undefined;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];
    const sessionLastAssistantText = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as {
          message?: string;
          sessionKey?: string;
          channel?: string;
          timeout?: number;
        };
        const message = params?.message ?? "";
        const sessionKey = params?.sessionKey ?? "";
        if (message === "Sub-agent announce step.") {
          sessionLastAssistantText.set(sessionKey, "announce now");
        } else {
          childRunId = runId;
          childSessionKey = sessionKey;
          sessionLastAssistantText.set(sessionKey, "result");
          expect(params?.channel).toBe("discord");
          expect(params?.timeout).toBe(1);
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as
          | { runId?: string; timeoutMs?: number }
          | undefined;
        waitCalls.push(params ?? {});
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 3000,
          endedAt: 4000,
        };
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        const text =
          sessionLastAssistantText.get(params?.sessionKey ?? "") ?? "";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      if (request.method === "sessions.delete") {
        const params = request.params as { key?: string } | undefined;
        deletedKey = params?.key;
        return { ok: true };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call1b", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const second = agentCalls[1]?.params as
      | { channel?: string; deliver?: boolean; lane?: string }
      | undefined;
    expect(second?.lane).toBe("nested");
    expect(second?.deliver).toBe(false);
    expect(second?.channel).toBe("webchat");

    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:req");
    expect(sendParams.message ?? "").toContain("announce now");
    expect(sendParams.message ?? "").toContain("Stats:");
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn resolves main announce target from sessions.list", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];
    const sessionLastAssistantText = new Map<string, string>();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: "main",
              lastChannel: "whatsapp",
              lastTo: "+123",
            },
          ],
        };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as {
          message?: string;
          sessionKey?: string;
        };
        const message = params?.message ?? "";
        const sessionKey = params?.sessionKey ?? "";
        if (message === "Sub-agent announce step.") {
          sessionLastAssistantText.set(sessionKey, "hello from sub");
        } else {
          childRunId = runId;
          childSessionKey = sessionKey;
          sessionLastAssistantText.set(sessionKey, "done");
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as
          | { runId?: string; timeoutMs?: number }
          | undefined;
        waitCalls.push(params ?? {});
        const status = params?.runId === childRunId ? "timeout" : "ok";
        return { runId: params?.runId ?? "run-1", status };
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        const text =
          sessionLastAssistantText.get(params?.sessionKey ?? "") ?? "";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m1" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    if (!childRunId) throw new Error("missing child runId");
    emitAgentEvent({
      runId: childRunId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1000,
        endedAt: 2000,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(sendParams.channel).toBe("whatsapp");
    expect(sendParams.to).toBe("+123");
    expect(sendParams.message ?? "").toContain("hello from sub");
    expect(sendParams.message ?? "").toContain("Stats:");
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn only allows same-agent by default", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call6", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn allows cross-agent spawning when configured", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["beta"],
            },
          },
        ],
      },
    };

    let childSessionKey: string | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        childSessionKey = params?.sessionKey;
        return { runId: "run-1", status: "accepted", acceptedAt: 5000 };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call7", {
      task: "do thing",
      agentId: "beta",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(childSessionKey?.startsWith("agent:beta:subagent:")).toBe(true);
  });

  it("sessions_spawn allows any agent when allowlist is *", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["*"],
            },
          },
        ],
      },
    };

    let childSessionKey: string | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        childSessionKey = params?.sessionKey;
        return { runId: "run-1", status: "accepted", acceptedAt: 5100 };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call8", {
      task: "do thing",
      agentId: "beta",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(childSessionKey?.startsWith("agent:beta:subagent:")).toBe(true);
  });

  it("sessions_spawn normalizes allowlisted agent ids", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["Research"],
            },
          },
        ],
      },
    };

    let childSessionKey: string | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        childSessionKey = params?.sessionKey;
        return { runId: "run-1", status: "accepted", acceptedAt: 5200 };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call10", {
      task: "do thing",
      agentId: "research",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(childSessionKey?.startsWith("agent:research:subagent:")).toBe(true);
  });

  it("sessions_spawn forbids cross-agent spawning when not allowed", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["alpha"],
            },
          },
        ],
      },
    };

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call9", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
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

    const tool = createClawdbotTools({
      agentSessionKey: "discord:group:req",
      agentSurface: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

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

    const patchIndex = calls.findIndex(
      (call) => call.method === "sessions.patch",
    );
    const agentIndex = calls.findIndex((call) => call.method === "agent");
    expect(patchIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(-1);
    expect(patchIndex).toBeLessThan(agentIndex);
    const patchCall = calls[patchIndex];
    expect(patchCall?.params).toMatchObject({
      key: expect.stringContaining("subagent:"),
      model: "claude-haiku-4-5",
    });
  });

  it("sessions_spawn applies default subagent model from defaults config", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.1" } } },
    };
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

    const tool = createClawdbotTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call-default-model", {
      task: "do thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });

    const patchCall = calls.find((call) => call.method === "sessions.patch");
    expect(patchCall?.params).toMatchObject({
      model: "minimax/MiniMax-M2.1",
    });
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

    const tool = createClawdbotTools({
      agentSessionKey: "agent:research:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

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

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call4", {
      task: "do thing",
      runTimeoutSeconds: 1,
      model: "bad-model",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      modelApplied: false,
    });
    expect(
      String((result.details as { warning?: string }).warning ?? ""),
    ).toContain("invalid model");
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

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

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
