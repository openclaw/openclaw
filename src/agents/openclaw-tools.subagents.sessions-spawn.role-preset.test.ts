import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

function makeRepoWorkspace(prefix: string): string {
  const repoRoot = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  return repoRoot;
}

describe("sessions_spawn role-aware defaults", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSessionsSpawnConfigOverride();
  });

  it("persists planner build-run metadata and injects planner artifact guidance", async () => {
    const repoRoot = makeRepoWorkspace("openclaw-role-preset-planner");
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
          },
        },
        list: [{ id: "main", workspace: repoRoot }],
      },
    });

    const patchCalls: Array<Record<string, unknown>> = [];
    let spawnedAgentParams: Record<string, unknown> | undefined;
    setupSessionsSpawnGatewayMock({
      onSessionsPatch: (params) => {
        patchCalls.push((params as Record<string, unknown>) ?? {});
      },
      onAgentSubagentSpawn: (params) => {
        spawnedAgentParams = (params as Record<string, unknown>) ?? {};
      },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      workspaceDir: repoRoot,
    });

    const result = await tool.execute("call-role-preset-planner", {
      task: "Plan the implementation",
      rolePreset: "planner",
      buildRunId: "run-42",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(patchCalls.some((params) => params.subagentRolePreset === "planner")).toBe(true);
    expect(
      patchCalls.some(
        (params) =>
          params.spawnedBuildRunId === "run-42" &&
          params.spawnedBuildRunDir === path.join(repoRoot, ".openclaw", "build-runs", "run-42"),
      ),
    ).toBe(true);
    expect(spawnedAgentParams?.buildRunId).toBe("run-42");
    expect(spawnedAgentParams?.buildRunDir).toBe(
      path.join(repoRoot, ".openclaw", "build-runs", "run-42"),
    );
    expect(typeof spawnedAgentParams?.extraSystemPrompt).toBe("string");
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain(
      "[Role Preset] Operate as planner.",
    );
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain("acceptance.json");
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain("verify-pack.json");
  });

  it("inherits build-run metadata from spawned tool context when not passed explicitly", async () => {
    const repoRoot = makeRepoWorkspace("openclaw-role-preset-evaluator");
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
          },
        },
        list: [{ id: "main", workspace: repoRoot }],
      },
    });

    const patchCalls: Array<Record<string, unknown>> = [];
    let spawnedAgentParams: Record<string, unknown> | undefined;
    setupSessionsSpawnGatewayMock({
      onSessionsPatch: (params) => {
        patchCalls.push((params as Record<string, unknown>) ?? {});
      },
      onAgentSubagentSpawn: (params) => {
        spawnedAgentParams = (params as Record<string, unknown>) ?? {};
      },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      workspaceDir: repoRoot,
      buildRunId: "run-99",
      buildRunDir: path.join(repoRoot, ".openclaw", "build-runs", "run-99"),
    });

    const result = await tool.execute("call-role-preset-evaluator", {
      task: "Evaluate the latest build",
      rolePreset: "evaluator",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(patchCalls.some((params) => params.subagentRolePreset === "evaluator")).toBe(true);
    expect(
      patchCalls.some(
        (params) =>
          params.spawnedBuildRunId === "run-99" &&
          params.spawnedBuildRunDir === path.join(repoRoot, ".openclaw", "build-runs", "run-99"),
      ),
    ).toBe(true);
    expect(spawnedAgentParams?.buildRunId).toBe("run-99");
    expect(typeof spawnedAgentParams?.extraSystemPrompt).toBe("string");
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain(
      "[Role Preset] Operate as evaluator.",
    );
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain("build-report.json");
    expect(String(spawnedAgentParams?.extraSystemPrompt)).toContain("eval-report.json");
  });
});
