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

describe("openclaw-tools: subagents (sessions_spawn allowlist)", () => {
  function setAllowAgents(allowAgents: string[]) {
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
              allowAgents,
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

  async function executeSpawn(callId: string, agentId: string, sandbox?: "inherit" | "require") {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    return tool.execute(callId, { task: "do thing", agentId, sandbox });
  }

  function setResearchUnsandboxedConfig(params?: { includeSandboxedDefault?: boolean }) {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        ...(params?.includeSandboxedDefault
          ? {
              defaults: {
                sandbox: {
                  mode: "all",
                },
              },
            }
          : {}),
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["research"],
            },
          },
          {
            id: "research",
            sandbox: {
              mode: "off",
            },
          },
        ],
      },
    });
  }

  async function expectAllowedSpawn(params: {
    allowAgents: string[];
    agentId: string;
    callId: string;
    acceptedAt: number;
  }) {
    setAllowAgents(params.allowAgents);
    const getChildSessionKey = mockAcceptedSpawn(params.acceptedAt);

    const result = await executeSpawn(params.callId, params.agentId);

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith(`agent:${params.agentId}:subagent:`)).toBe(true);
  }

  async function expectInvalidAgentId(callId: string, agentId: string) {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }],
      },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute(callId, { task: "do thing", agentId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Invalid agentId");
    expect(callGatewayMock).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  it("sessions_spawn only allows same-agent by default", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call6", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn forbids cross-agent spawning when not allowed", async () => {
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
              allowAgents: ["alpha"],
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call9", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn allows cross-agent spawning when configured", async () => {
    await expectAllowedSpawn({
      allowAgents: ["beta"],
      agentId: "beta",
      callId: "call7",
      acceptedAt: 5000,
    });
  });

  it("sessions_spawn allows any agent when allowlist is *", async () => {
    await expectAllowedSpawn({
      allowAgents: ["*"],
      agentId: "beta",
      callId: "call8",
      acceptedAt: 5100,
    });
  });

  it("sessions_spawn normalizes allowlisted agent ids", async () => {
    await expectAllowedSpawn({
      allowAgents: ["Research"],
      agentId: "research",
      callId: "call10",
      acceptedAt: 5200,
    });
  });

  it("forbids sandboxed cross-agent spawns that would unsandbox the child", async () => {
    setResearchUnsandboxedConfig({ includeSandboxedDefault: true });

    const result = await executeSpawn("call11", "research");
    const details = result.details as { status?: string; error?: string };

    expect(details.status).toBe("forbidden");
    expect(details.error).toContain("Sandboxed sessions cannot spawn unsandboxed subagents.");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it('forbids sandbox="require" when target runtime is unsandboxed', async () => {
    setResearchUnsandboxedConfig();

    const result = await executeSpawn("call12", "research", "require");
    const details = result.details as { status?: string; error?: string };

    expect(details.status).toBe("forbidden");
    expect(details.error).toContain('sandbox="require"');
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
  // ---------------------------------------------------------------------------
  // agentId format validation (#31311)
  // ---------------------------------------------------------------------------

  it("rejects error-message-like strings as agentId (#31311)", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "research" }],
      },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    const result = await tool.execute("call-err-msg", {
      task: "do thing",
      agentId: "Agent not found: xyz",
    });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Invalid agentId");
    expect(details.error).toContain("agents_list");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects agentId containing path separators (#31311)", async () => {
    await expectInvalidAgentId("call-path", "../../../etc/passwd");
  });

  it("rejects agentId exceeding 64 characters (#31311)", async () => {
    await expectInvalidAgentId("call-long", "a".repeat(65));
  });

  it("accepts well-formed agentId with hyphens and underscores (#31311)", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "my-research_agent01" }],
      },
    });
    mockAcceptedSpawn(1000);
    const result = await executeSpawn("call-valid", "my-research_agent01");
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
  });

  it("allows allowlisted-but-unconfigured agentId (#31311)", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          { id: "main", subagents: { allowAgents: ["research"] } },
          // "research" is NOT in agents.list — only in allowAgents
        ],
      },
    });
    mockAcceptedSpawn(1000);
    const result = await executeSpawn("call-unconfigured", "research");
    const details = result.details as { status?: string };
    // Must pass: "research" is in allowAgents even though not in agents.list
    expect(details.status).toBe("accepted");
  });

  it("sessions_spawn resolves kissinger alias to catering_pipeline_builder", async () => {
    setAllowAgents(["catering_pipeline_builder"]);
    const getChildSessionKey = mockAcceptedSpawn(5300);
    const result = await executeSpawn("call11", "kissinger");
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith("agent:catering_pipeline_builder:subagent:")).toBe(
      true,
    );
  });

  it("sessions_spawn resolves friedman alias to cost_controller", async () => {
    setAllowAgents(["cost_controller"]);
    const getChildSessionKey = mockAcceptedSpawn(5400);
    const result = await executeSpawn("call12", "friedman");
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith("agent:cost_controller:subagent:")).toBe(true);
  });

  it("sessions_spawn resolves olivetti alias to capacity_controller", async () => {
    setAllowAgents(["capacity_controller"]);
    const getChildSessionKey = mockAcceptedSpawn(5500);
    const result = await executeSpawn("call13", "olivetti");
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith("agent:capacity_controller:subagent:")).toBe(true);
  });
});
