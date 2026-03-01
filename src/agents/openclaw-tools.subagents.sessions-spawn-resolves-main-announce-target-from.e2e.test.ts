import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { sleep } from "../utils.ts";
import { createOpenClawTools } from "./openclaw-tools.js";
import "./test-helpers/fast-core-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  const state = { configOverride: defaultConfigOverride };
  return { callGatewayMock, defaultConfigOverride, state };
});

const callGatewayMock = hoisted.callGatewayMock;

function resetConfigOverride() {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});

describe("openclaw-tools: subagents", () => {
  beforeEach(() => {
    resetConfigOverride();
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];
    let patchParams: { key?: string; label?: string } = {};

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
          lane?: string;
        };
        // Only capture the first agent call (subagent spawn, not main agent trigger)
        if (params?.lane === "subagent") {
          childRunId = runId;
          childSessionKey = params?.sessionKey ?? "";
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string; timeoutMs?: number } | undefined;
        waitCalls.push(params ?? {});
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 1000,
          endedAt: 2000,
        };
      }
      if (request.method === "sessions.patch") {
        const params = request.params as { key?: string; label?: string } | undefined;
        patchParams = { key: params?.key, label: params?.label };
        return { ok: true };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          ],
        };
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

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
      label: "my-task",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    if (!childRunId) {
      throw new Error("missing child runId");
    }
    emitAgentEvent({
      runId: childRunId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1000,
        endedAt: 2000,
      },
    });

    await sleep(0);
    await sleep(0);
    await sleep(0);

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    expect(patchParams.key).toBe(childSessionKey);
    expect(patchParams.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn only allows same-agent by default", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call6", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
