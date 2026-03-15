import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn allowedBy)", () => {
  function setConfig(opts: { requesterAllowAgents?: string[]; targetAllowedBy?: string[] }) {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "requester",
            subagents: {
              allowAgents: opts.requesterAllowAgents ?? ["*"],
            },
          },
          {
            id: "target",
            subagents: {
              allowedBy: opts.targetAllowedBy,
            },
          },
        ],
      },
    });
  }

  function mockAcceptedSpawn(acceptedAt: number) {
    let childSessionKey: string | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        childSessionKey = params?.sessionKey;
        return { runId: "run-1", status: "accepted", acceptedAt };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    return () => childSessionKey;
  }

  async function executeSpawn(callId: string) {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:requester:main",
      agentChannel: "whatsapp",
    });
    return tool.execute(callId, { task: "do thing", agentId: "target" });
  }

  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
  });

  it("allows any spawner when allowedBy is not set (backwards compatible)", async () => {
    setConfig({});
    mockAcceptedSpawn(Date.now());
    const result = await executeSpawn("c1");
    expect(result.details).toMatchObject({ status: "accepted" });
  });

  it("forbids when allowedBy excludes the requester", async () => {
    setConfig({ targetAllowedBy: ["other-agent"] });
    const result = await executeSpawn("c2");
    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows when allowedBy includes the requester", async () => {
    setConfig({ targetAllowedBy: ["requester"] });
    mockAcceptedSpawn(Date.now());
    const result = await executeSpawn("c3");
    expect(result.details).toMatchObject({ status: "accepted" });
  });

  it("allows any spawner with wildcard ['*']", async () => {
    setConfig({ targetAllowedBy: ["*"] });
    mockAcceptedSpawn(Date.now());
    const result = await executeSpawn("c4");
    expect(result.details).toMatchObject({ status: "accepted" });
  });

  it("normalizes agent ids (case-insensitive)", async () => {
    setConfig({ targetAllowedBy: ["REQUESTER"] });
    mockAcceptedSpawn(Date.now());
    const result = await executeSpawn("c5");
    expect(result.details).toMatchObject({ status: "accepted" });
  });

  it("skips check for same-agent spawns", async () => {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "requester",
            subagents: {
              allowAgents: ["*"],
              allowedBy: ["nobody"],
            },
          },
        ],
      },
    });
    mockAcceptedSpawn(Date.now());
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:requester:main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("c6", { task: "do thing" });
    expect(result.details).toMatchObject({ status: "accepted" });
  });
});
