import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

type CreateOpenClawTools = (typeof import("./openclaw-tools.js"))["createOpenClawTools"];
type CreateOpenClawToolsOpts = Parameters<CreateOpenClawTools>[0];

async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  const { createOpenClawTools } = await import("./openclaw-tools.js");
  const tool = createOpenClawTools(opts).find((candidate) => candidate.name === "sessions_spawn");
  if (!tool) {
    throw new Error("missing sessions_spawn tool");
  }
  return tool;
}

function mockGatewayAccept() {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: unknown };
    if (request.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 5000 };
    }
    if (request.method === "agent.wait") {
      return { status: "timeout" };
    }
    return {};
  });
}

describe("openclaw-tools: subagents (sessions_spawn spawnableBy)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
  });

  it("sessions_spawn allows any spawner when spawnableBy is not set", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    mockGatewayAccept();
    setSessionsSpawnConfigOverride({
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
          {
            id: "beta",
            // no spawnableBy — should allow any spawner
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-1", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });
  });

  it("sessions_spawn forbids spawning when spawnableBy excludes requester", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    setSessionsSpawnConfigOverride({
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
          {
            id: "beta",
            subagents: {
              spawnableBy: ["alpha"], // main is NOT allowed
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-2", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn allows spawning when spawnableBy includes requester", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    mockGatewayAccept();
    setSessionsSpawnConfigOverride({
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
          {
            id: "beta",
            subagents: {
              spawnableBy: ["main"],
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-3", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });
  });

  it("sessions_spawn allows any spawner when spawnableBy is [*]", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    mockGatewayAccept();
    setSessionsSpawnConfigOverride({
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
          {
            id: "beta",
            subagents: {
              spawnableBy: ["*"],
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-4", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });
  });

  it("sessions_spawn normalizes spawnableBy agent ids", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    mockGatewayAccept();
    setSessionsSpawnConfigOverride({
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
          {
            id: "beta",
            subagents: {
              spawnableBy: ["Main"], // uppercase — should still match
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-5", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });
  });

  it("sessions_spawn skips spawnableBy check for same-agent spawns", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    mockGatewayAccept();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              spawnableBy: ["nobody"], // restrictive, but same-agent should bypass
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-sb-6", {
      task: "do thing",
      // no agentId — same agent
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });
  });
});
