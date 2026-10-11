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
  it("keeps a raw ACP harness under the requester OpenClaw owner and workspace", async () => {
    const workspace = await fixture.createCrossAgentWorkspaceFixture();
    try {
      fixture.state.cfg.acp = { ...fixture.state.cfg.acp, allowedAgents: ["codex"] };
      fixture.state.cfg.agents = {
        entries: { main: { workspace: workspace.mainWorkspace } },
      };
      const accepted = fixture.expectAcceptedSpawn(
        await fixture.spawn({ agentId: "codex", mode: "run" }),
      );
      expect(accepted.childSessionKey).toMatch(/^agent:main:acp:/);
      fixture.expectInitializeSessionFields({
        agentId: "main",
        agent: "codex",
        cwd: workspace.mainWorkspace,
        sessionKey: accepted.childSessionKey,
      });
      expectRegisteredSubagentRun(
        fixture.registerSubagentRunMock,
        {
          childSessionKey: accepted.childSessionKey,
          agentId: "main",
          requesterAgentId: "main",
        },
        { assertCurrent: undefined },
      );
    } finally {
      await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });
    }
  });

  it.each([true, false])("resolves the target workspace (exists=%s)", async (exists) => {
    const workspace = await fixture.createCrossAgentWorkspaceFixture({
      createTargetWorkspace: exists,
    });
    try {
      fixture.state.cfg.acp = {
        ...fixture.state.cfg.acp,
        allowedAgents: ["codex", "claude-code"],
      };
      fixture.state.cfg.agents = {
        entries: {
          main: { workspace: workspace.mainWorkspace },
          "claude-code": { workspace: workspace.targetWorkspace },
        },
      };
      fixture.expectAcceptedSpawn(await fixture.spawn({ agentId: "claude-code", mode: "run" }));
      fixture.expectInitializeSessionFields({
        agentId: "claude-code",
        agent: "claude-code",
        cwd: exists ? workspace.targetWorkspace : undefined,
        sessionKey: expect.stringMatching(/^agent:claude-code:acp:/),
      });
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
