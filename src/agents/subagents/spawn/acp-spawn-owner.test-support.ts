import fs from "node:fs/promises";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { spawnAcpDirect } from "./acp-spawn.js";
import { expectRegisteredSubagentRun } from "./subagent-spawn.test-helpers.js";

type SpawnFn = (
  request: Partial<Parameters<typeof spawnAcpDirect>[0]>,
) => ReturnType<typeof spawnAcpDirect>;
type SpawnResult = Awaited<ReturnType<SpawnFn>>;

export function registerAcpSpawnOwnerTests(fixture: {
  spawn: SpawnFn;
  state: { cfg: OpenClawConfig };
  registerSubagentRunMock: unknown;
  readAcpResumeSessionOwnerMock: {
    mockResolvedValue: (value: unknown) => unknown;
  };
  expectAcceptedSpawn: (result: SpawnResult) => Extract<SpawnResult, { status: "accepted" }>;
  expectInitializeSessionFields: (expected: Record<string, unknown>) => Record<string, unknown>;
  createCrossAgentWorkspaceFixture: (options?: {
    createTargetWorkspace?: boolean;
  }) => Promise<{ workspaceRoot: string; mainWorkspace: string; targetWorkspace: string }>;
}) {
  it.each([
    { agent: "codex", exists: true },
    { agent: "claude-code", exists: true },
    { agent: "claude-code", exists: false },
  ])("resolves $agent ownership and workspace (exists=$exists)", async ({ agent, exists }) => {
    const workspace = await fixture.createCrossAgentWorkspaceFixture({
      createTargetWorkspace: exists,
    });
    const rawHarness = agent === "codex";
    const owner = rawHarness ? "main" : agent;
    try {
      fixture.state.cfg.acp = {
        ...fixture.state.cfg.acp,
        allowedAgents: rawHarness ? [agent] : ["codex", agent],
      };
      fixture.state.cfg.agents = {
        entries: {
          main: { workspace: workspace.mainWorkspace },
          ...(!rawHarness ? { [agent]: { workspace: workspace.targetWorkspace } } : {}),
        },
      };
      const accepted = fixture.expectAcceptedSpawn(
        await fixture.spawn({ agentId: agent, mode: "run" }),
      );
      expect(accepted.childSessionKey).toMatch(new RegExp(`^agent:${owner}:acp:`));
      fixture.expectInitializeSessionFields({
        agentId: owner,
        agent,
        cwd: rawHarness ? workspace.mainWorkspace : exists ? workspace.targetWorkspace : undefined,
        sessionKey: accepted.childSessionKey,
      });
      if (rawHarness) {
        expectRegisteredSubagentRun(
          fixture.registerSubagentRunMock,
          {
            childSessionKey: accepted.childSessionKey,
            childAgentId: "main",
            requesterAgentId: "main",
          },
          { assertCurrent: undefined },
        );
      }
    } finally {
      await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resumes through the configured ACP owner and backend", async () => {
    fixture.state.cfg.agents = {
      ...fixture.state.cfg.agents,
      entries: {
        reviewer: { runtime: { type: "acp", acp: { agent: "codex", backend: "fallback" } } },
      },
    };
    const resumeSessionId = "fixture-resume";
    fixture.readAcpResumeSessionOwnerMock.mockResolvedValue({
      sessionKey: "agent:reviewer:acp:owned",
      entry: { sessionId: "sess-owned", updatedAt: 100, spawnedBy: "agent:main:main" },
    });
    fixture.expectAcceptedSpawn(await fixture.spawn({ agentId: "reviewer", resumeSessionId }));
    expect(fixture.readAcpResumeSessionOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "reviewer",
        runtimeAgentId: "codex",
        backendId: "fallback",
        resumeSessionId,
      }),
    );
    fixture.expectInitializeSessionFields({
      agentId: "reviewer",
      agent: "codex",
      resumeSessionId,
      backendId: "fallback",
    });
  });
}
