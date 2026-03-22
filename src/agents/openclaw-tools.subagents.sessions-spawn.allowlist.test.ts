import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import "./test-helpers/fast-core-tools.js";
import { SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT } from "./sessions-spawn-failure-guard.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn allowlist)", () => {
  async function seedRegistryFixture(): Promise<void> {
    const { resolveOperatorReferenceSourcePath } =
      await import("../operator-control/reference-paths.js");
    const { invalidateRegistryCache } = await import("../operator-control/agent-registry.js");
    const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      [
        "agents:",
        "  - id: bobby-digital",
        "    name: Bobby Digital",
        "    specialty: Engineering",
        "    triggers: [engineering, backend]",
        "  - id: ghostface",
        "    name: Ghostface",
        "    specialty: Backend",
        "    triggers: [backend]",
        "teams:",
        "  - id: engineering",
        "    name: Engineering",
        "    lead: bobby-digital",
        "    route_via_lead: true",
        "    members: [bobby-digital, ghostface]",
        "",
      ].join("\n"),
      "utf8",
    );
    invalidateRegistryCache({ sourcePath });
  }

  async function createReadyWorkspaces(agentIds: string[]) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-targets-"));
    const workspaces = Object.fromEntries(
      await Promise.all(
        agentIds.map(async (agentId) => {
          const workspace = path.join(rootDir, agentId);
          await fs.mkdir(workspace, { recursive: true });
          await fs.writeFile(path.join(workspace, "AGENTS.md"), `# ${agentId}\n`, "utf8");
          return [agentId, workspace] as const;
        }),
      ),
    );
    return workspaces;
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
      requesterAgentIdOverride: "main",
    });
    return tool.execute(callId, { task: "do thing", agentId, sandbox });
  }

  async function executeSpawnRaw(callId: string, args: Record<string, unknown>) {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      requesterAgentIdOverride: "main",
    });
    return tool.execute(callId, args);
  }

  async function executeSpawnFromRequester(params: {
    callId: string;
    requesterAgentId: string;
    agentId: string;
    sandbox?: "inherit" | "require";
  }) {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: `agent:${params.requesterAgentId}:main`,
      agentChannel: "whatsapp",
      requesterAgentIdOverride: params.requesterAgentId,
    });
    return tool.execute(params.callId, {
      task: "do thing",
      agentId: params.agentId,
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
    });
  }

  async function executeTeamSpawn(params: {
    callId: string;
    teamId: string;
    capability?: string;
    role?: string;
  }) {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:bobby-digital:main",
      agentChannel: "whatsapp",
      requesterAgentIdOverride: "bobby-digital",
    });
    return tool.execute(params.callId, {
      task: "route the work",
      teamId: params.teamId,
      ...(params.capability ? { capability: params.capability } : {}),
      ...(params.role ? { role: params.role } : {}),
    });
  }

  async function expectAllowedSpawn(params: {
    allowAgents: string[];
    agentId: string;
    callId: string;
    acceptedAt: number;
  }) {
    const workspaces = await createReadyWorkspaces(["main", params.agentId]);
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            workspace: workspaces.main,
            subagents: {
              allowAgents: params.allowAgents,
            },
          },
          {
            id: params.agentId,
            workspace: workspaces[params.agentId],
          },
        ],
      },
    });
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
        list: [{ id: "main", workspace: "/tmp/openclaw-main", subagents: { allowAgents: ["*"] } }],
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

  beforeEach(async () => {
    resetSessionsSpawnConfigOverride();
    const { resetSubagentRegistryForTests } = await import("./subagent-registry.js");
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

  it("returns a validation error when task is missing", async () => {
    const result = await executeSpawnRaw("call-missing-task", {});
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("task required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("blocks repeated schema-shape failures via the global failure budget", async () => {
    for (let idx = 0; idx < SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT - 1; idx += 1) {
      const result = await executeSpawnRaw(`call-invalid-mode-${idx}`, {
        task: "do thing",
        mode: "invalid-mode",
      });
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain('mode must be "run" or "session"');
    }

    const blocked = await executeSpawnRaw("call-invalid-mode-blocked", {
      task: "do thing",
      mode: "invalid-mode",
    });
    const blockedDetails = blocked.details as { status?: string; error?: string };
    expect(blockedDetails.status).toBe("forbidden");
    expect(blockedDetails.error).toContain("temporarily blocked for this session");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows Scout from an unconfigured specialist requester only", async () => {
    const workspaces = await createReadyWorkspaces(["scout"]);
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          { id: "main", workspace: "/tmp/openclaw-main" },
          { id: "scout", workspace: workspaces.scout },
        ],
      },
    });
    const getChildSessionKey = mockAcceptedSpawn(5300);

    const scoutResult = await executeSpawnFromRequester({
      callId: "call-scout-specialist",
      requesterAgentId: "method-man",
      agentId: "scout",
    });
    expect(scoutResult.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith("agent:scout:subagent:")).toBe(true);

    callGatewayMock.mockClear();
    const blockedResult = await executeSpawnFromRequester({
      callId: "call-blocked-specialist",
      requesterAgentId: "method-man",
      agentId: "ghostface",
    });
    expect(blockedResult.details).toMatchObject({
      status: "forbidden",
    });
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

  it("surfaces unavailable allowed helpers and suppresses repeated allowlist retry churn", async () => {
    const workspaces = await createReadyWorkspaces(["main", "scout"]);
    await fs.rm(path.join(workspaces.scout, "AGENTS.md"));
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            workspace: workspaces.main,
            subagents: {
              allowAgents: ["scout"],
            },
          },
          {
            id: "scout",
            workspace: workspaces.scout,
          },
        ],
      },
    });

    const first = await executeSpawn("call9a", "reverend-run");
    const firstDetails = first.details as { status?: string; error?: string };
    expect(firstDetails.status).toBe("forbidden");
    expect(firstDetails.error).toContain(
      "agentId is not allowed for sessions_spawn (allowed: scout)",
    );
    expect(firstDetails.error).toContain('Do not retry variants for "reverend-run"');
    expect(firstDetails.error).toContain("Allowed ready fallback agents: none.");
    expect(firstDetails.error).toContain("Allowed but unavailable targets: scout");
    expect(firstDetails.error).toContain("workspace is missing AGENTS.md");

    const second = await executeSpawn("call9b", "reverend-run");
    const secondDetails = second.details as { status?: string; error?: string };
    expect(secondDetails.status).toBe("forbidden");
    expect(secondDetails.error).toContain(
      'Skipping repeated sessions_spawn retry for "reverend-run"',
    );
    expect(secondDetails.error).toContain(
      "agentId is not allowed for sessions_spawn (allowed: scout)",
    );
    expect(
      callGatewayMock.mock.calls.some(
        ([request]) => (request as { method?: string })?.method === "agent",
      ),
    ).toBe(false);
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

  it("includes ready fallback agents when the requested helper workspace is not ready", async () => {
    const workspaces = await createReadyWorkspaces(["main", "scout", "reverend-run"]);
    await fs.rm(path.join(workspaces.scout, "AGENTS.md"));
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            workspace: workspaces.main,
            subagents: {
              allowAgents: ["scout", "reverend-run"],
            },
          },
          {
            id: "scout",
            workspace: workspaces.scout,
          },
          {
            id: "reverend-run",
            workspace: workspaces["reverend-run"],
          },
        ],
      },
    });

    const result = await executeSpawn("call10a", "scout");
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain('agentId "scout" is not workspace-backed');
    expect(details.error).toContain("workspace is missing AGENTS.md");
    expect(details.error).toContain('Do not retry variants for "scout"');
    expect(details.error).toContain("Allowed ready fallback agents: reverend-run.");
  });

  it("forbids sandboxed cross-agent spawns that would unsandbox the child", async () => {
    const workspaces = await createReadyWorkspaces(["research"]);
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/openclaw-main",
            subagents: {
              allowAgents: ["research"],
            },
          },
          {
            id: "research",
            workspace: workspaces.research,
            sandbox: {
              mode: "off",
            },
          },
        ],
      },
    });

    const result = await executeSpawn("call11", "research");
    const details = result.details as { status?: string; error?: string };

    expect(details.status).toBe("forbidden");
    expect(details.error).toContain("Sandboxed sessions cannot spawn unsandboxed subagents.");
  });

  it('forbids sandbox="require" when target runtime is unsandboxed', async () => {
    const workspaces = await createReadyWorkspaces(["research"]);
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            workspace: "/tmp/openclaw-main",
            subagents: {
              allowAgents: ["research"],
            },
          },
          {
            id: "research",
            workspace: workspaces.research,
            sandbox: {
              mode: "off",
            },
          },
        ],
      },
    });

    const result = await executeSpawn("call12", "research", "require");
    const details = result.details as { status?: string; error?: string };

    expect(details.status).toBe("forbidden");
    expect(details.error).toContain('sandbox="require"');
  });
  // ---------------------------------------------------------------------------
  // agentId format validation (#31311)
  // ---------------------------------------------------------------------------

  it("rejects error-message-like strings as agentId (#31311)", async () => {
    const workspaces = await createReadyWorkspaces(["research"]);
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          { id: "main", workspace: "/tmp/openclaw-main", subagents: { allowAgents: ["*"] } },
          { id: "research", workspace: workspaces.research },
        ],
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
  });

  it("rejects agentId containing path separators (#31311)", async () => {
    await expectInvalidAgentId("call-path", "../../../etc/passwd");
  });

  it("rejects agentId exceeding 64 characters (#31311)", async () => {
    await expectInvalidAgentId("call-long", "a".repeat(65));
  });

  it("accepts well-formed agentId with hyphens and underscores (#31311)", async () => {
    const workspaces = await createReadyWorkspaces(["my-research_agent01"]);
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          { id: "main", workspace: "/tmp/openclaw-main", subagents: { allowAgents: ["*"] } },
          { id: "my-research_agent01", workspace: workspaces["my-research_agent01"] },
        ],
      },
    });
    mockAcceptedSpawn(1000);
    const result = await executeSpawn("call-valid", "my-research_agent01");
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
  });

  it("rejects allowlisted-but-unconfigured agentId (#31311)", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          { id: "main", workspace: "/tmp/openclaw-main", subagents: { allowAgents: ["research"] } },
        ],
      },
    });
    const result = await executeSpawn("call-unconfigured", "research");
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("stale allowlist entry");
  });

  it("resolves teamId + capability to the lead-selected specialist", async () => {
    await withStateDirEnv("sessions-spawn-team-selector-", async () => {
      await seedRegistryFixture();
      const workspaces = await createReadyWorkspaces(["bobby-digital"]);
      setSessionsSpawnConfigOverride({
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          list: [
            {
              id: "bobby-digital",
              workspace: workspaces["bobby-digital"],
              subagents: { allowAgents: ["bobby-digital"] },
            },
            { id: "ghostface" },
          ],
        },
      });
      const getChildSessionKey = mockAcceptedSpawn(1000);

      const result = await executeTeamSpawn({
        callId: "call-team-capability",
        teamId: "engineering",
        capability: "backend",
      });

      expect((result.details as { status?: string }).status).toBe("accepted");
      expect(getChildSessionKey()?.startsWith("agent:bobby-digital:subagent:")).toBe(true);
    });
  });

  it("resolves teamId + role alias the same way", async () => {
    await withStateDirEnv("sessions-spawn-team-role-", async () => {
      await seedRegistryFixture();
      const workspaces = await createReadyWorkspaces(["bobby-digital"]);
      setSessionsSpawnConfigOverride({
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          list: [
            {
              id: "bobby-digital",
              workspace: workspaces["bobby-digital"],
              subagents: { allowAgents: ["bobby-digital"] },
            },
            { id: "ghostface" },
          ],
        },
      });
      const getChildSessionKey = mockAcceptedSpawn(1000);

      const result = await executeTeamSpawn({
        callId: "call-team-role",
        teamId: "engineering",
        role: "backend",
      });

      expect((result.details as { status?: string }).status).toBe("accepted");
      expect(getChildSessionKey()?.startsWith("agent:bobby-digital:subagent:")).toBe(true);
    });
  });
});
