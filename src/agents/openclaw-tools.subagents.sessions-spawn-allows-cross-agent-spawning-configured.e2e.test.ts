import { beforeEach, describe, expect, it, vi } from "vitest";
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

function setConfigOverride(next: SessionsSpawnTestConfig) {
  hoisted.state.configOverride = next;
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

  it("sessions_spawn allows cross-agent spawning when configured", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    setConfigOverride({
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
    });

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

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

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
    setConfigOverride({
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
    });

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

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

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
});
