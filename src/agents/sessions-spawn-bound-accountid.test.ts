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

describe("sessions_spawn bound accountId resolution", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1 };
      }
      if (req.method === "agent.wait") {
        return { runId: "run-1", status: "running" };
      }
      return {};
    });
  });

  it("uses target agent's bound accountId over requester's accountId", async () => {
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["rex"] },
          },
          { id: "rex" },
        ],
      },
      bindings: [
        {
          agentId: "rex",
          match: { channel: "telegram", accountId: "rex-bot-token" },
        },
      ],
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "telegram",
      agentAccountId: "aria-bot-token",
      agentTo: "telegram:123",
      agentThreadId: 42,
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call", {
      task: "research this topic",
      agentId: "rex",
      runTimeoutSeconds: 1,
    });

    const agentCall = callGatewayMock.mock.calls.find(
      ([opts]: [{ method?: string }]) => opts.method === "agent",
    );
    expect(agentCall).toBeDefined();
    const params = agentCall![0].params;
    // Target agent's bound accountId should win over requester's.
    expect(params.accountId).toBe("rex-bot-token");
    // Thread context from requester should still be passed through.
    expect(params.to).toBe("telegram:123");
    expect(params.threadId).toBe("42");
  });

  it("falls back to requester's accountId when target has no binding", async () => {
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["scout"] },
          },
          { id: "scout" },
        ],
      },
      // No bindings for scout.
      bindings: [],
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "telegram",
      agentAccountId: "aria-bot-token",
      agentTo: "telegram:456",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call", {
      task: "scout this",
      agentId: "scout",
      runTimeoutSeconds: 1,
    });

    const agentCall = callGatewayMock.mock.calls.find(
      ([opts]: [{ method?: string }]) => opts.method === "agent",
    );
    expect(agentCall).toBeDefined();
    const params = agentCall![0].params;
    // No binding for scout → falls back to requester's accountId.
    expect(params.accountId).toBe("aria-bot-token");
    expect(params.to).toBe("telegram:456");
  });

  it("skips accountId resolution when requester has no channel (cron/hook spawns)", async () => {
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram", accountId: "main-bot-token" },
        },
      ],
    };

    // No channel/accountId — simulates a cron or hook spawn.
    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call", {
      task: "scheduled job",
      runTimeoutSeconds: 1,
    });

    const agentCall = callGatewayMock.mock.calls.find(
      ([opts]: [{ method?: string }]) => opts.method === "agent",
    );
    expect(agentCall).toBeDefined();
    const params = agentCall![0].params;
    // No channel means no binding resolution and no requester accountId.
    expect(params.accountId).toBeUndefined();
  });
});
