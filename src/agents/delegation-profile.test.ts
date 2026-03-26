import { describe, expect, it, afterEach } from "vitest";
import { buildDelegationProfile } from "./delegation-profile.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

describe("buildDelegationProfile", () => {
  it("reports main-session delegation defaults", () => {
    const profile = buildDelegationProfile({
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "agents_list" }, { name: "sessions_spawn" }, { name: "subagents" }] as never,
    });

    expect(profile).toMatchObject({
      role: "main",
      depth: 0,
      canSpawn: true,
      canControlChildren: true,
      workspaceSource: "primary",
      delegationToolsAllowed: ["agents_list", "sessions_spawn", "subagents"],
    });
    expect(profile?.delegationToolsBlocked).toContain("sessions_send");
  });

  it("reports inherited subagent delegation context and spawn task", () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:worker-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "Summarize the latest release notes",
      label: "release-notes",
      rolePreset: "planner",
      buildRunId: "run-42",
      buildRunDir: "/tmp/openclaw/.openclaw/build-runs/run-42",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const profile = buildDelegationProfile({
      sessionKey: "agent:main:subagent:worker-1",
      spawnedBy: "agent:main:main",
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              maxSpawnDepth: 2,
            },
          },
        },
      },
      tools: [
        { name: "sessions_spawn" },
        { name: "subagents" },
        { name: "sessions_list" },
        { name: "sessions_history" },
      ] as never,
    });

    expect(profile).toMatchObject({
      role: "orchestrator",
      rolePreset: "planner",
      promptMode: "plan",
      toolBias: "read-heavy",
      verificationPosture: "acceptance-first",
      artifactWriteScope: "planner-artifacts",
      depth: 1,
      canSpawn: true,
      workspaceSource: "inherited",
      buildRunId: "run-42",
      buildRunDir: "/tmp/openclaw/.openclaw/build-runs/run-42",
      parentSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      label: "release-notes",
      task: "Summarize the latest release notes",
    });
    expect(profile?.delegationToolsAllowed).toEqual([
      "sessions_spawn",
      "subagents",
      "sessions_list",
      "sessions_history",
    ]);
  });
});
