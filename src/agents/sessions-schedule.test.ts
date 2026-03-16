import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  return {
    callGatewayMock,
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => hoisted.callGatewayMock(...args),
}));

vi.mock("./subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("./acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

const { resetSessionsScheduleStateForTests, scheduleSessionsGraph } =
  await import("./sessions-schedule.js");

describe("sessions-schedule", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    hoisted.callGatewayMock.mockReset().mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string } | undefined)?.method;
      if (method === "agent.wait") {
        return await new Promise(() => {});
      }
      return {};
    });
    hoisted.spawnSubagentDirectMock.mockReset();
    hoisted.spawnAcpDirectMock.mockReset();
    resetSessionsScheduleStateForTests();
  });

  async function seedRegistryFixture(lines: string[]): Promise<void> {
    const { resolveOperatorReferenceSourcePath } =
      await import("../operator-control/reference-paths.js");
    const { invalidateRegistryCache } = await import("../operator-control/agent-registry.js");
    const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, `${lines.join("\n")}\n`, "utf8");
    invalidateRegistryCache({ sourcePath });
  }

  it("records resolved team routing metadata for scheduled team nodes", async () => {
    await withStateDirEnv("sessions-schedule-test-", async () => {
      configOverride = {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
        agents: {
          list: [
            {
              id: "bobby-digital",
              default: true,
              subagents: {
                allowAgents: ["method-man"],
              },
            },
          ],
        },
      };
      await seedRegistryFixture([
        "agents:",
        "  - id: bobby-digital",
        "    name: Bobby Digital",
        "    specialty: Engineering",
        "    triggers: [engineering]",
        "  - id: method-man",
        "    name: Method Man",
        "    specialty: Frontend",
        "    triggers: [frontend, ui]",
        "teams:",
        "  - id: engineering",
        "    name: Engineering",
        "    lead: bobby-digital",
        "    members: [bobby-digital]",
        "  - id: frontend",
        "    name: Frontend",
        "    parent_team_id: engineering",
        "    lead: method-man",
        "    route_via_lead: true",
        "    members: [method-man]",
        "    owns_capabilities: [frontend, ui]",
      ]);

      hoisted.spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:method-man:subagent:1",
        runId: "run-frontend",
      });

      const result = await scheduleSessionsGraph({
        nodes: [
          {
            id: "frontend",
            task: "Build the dashboard",
            teamId: "frontend",
            role: "frontend",
          },
        ],
        context: {
          agentSessionKey: "agent:bobby-digital:main",
          requesterAgentIdOverride: "bobby-digital",
        },
      });

      expect(result.nodes).toEqual([
        expect.objectContaining({
          id: "frontend",
          state: "running",
          resolvedAgentId: "method-man",
          resolvedTeamId: "frontend",
          resolvedCapability: "frontend",
          runId: "run-frontend",
        }),
      ]);
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "method-man",
          task: "Build the dashboard",
        }),
        expect.objectContaining({
          agentSessionKey: "agent:bobby-digital:main",
        }),
      );
    });
  });

  it("blocks downstream scheduled nodes when a prerequisite fails to start", async () => {
    hoisted.spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "forbidden",
      error: "agentId is not allowed for sessions_spawn (allowed: none)",
    });

    const result = await scheduleSessionsGraph({
      nodes: [
        {
          id: "first",
          task: "Attempt the first step",
          agentId: "method-man",
        },
        {
          id: "second",
          task: "Attempt the dependent step",
          agentId: "ghostface",
        },
      ],
      dependencies: [
        {
          from: "first",
          to: "second",
          type: "FS",
        },
      ],
      context: {
        agentSessionKey: "agent:bobby-digital:main",
        requesterAgentIdOverride: "bobby-digital",
      },
    });

    expect(result.summary).toMatchObject({
      failed: 1,
      blocked: 1,
    });
    expect(result.nodes).toEqual([
      expect.objectContaining({
        id: "first",
        state: "failed",
        error: "agentId is not allowed for sessions_spawn (allowed: none)",
      }),
      expect.objectContaining({
        id: "second",
        state: "blocked",
      }),
    ]);
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });
});
