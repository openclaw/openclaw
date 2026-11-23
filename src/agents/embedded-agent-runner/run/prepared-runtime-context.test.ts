import { describe, expect, it, vi } from "vitest";
import {
  bindPreparedModelRuntimeAuth,
  getPreparedModelRuntimePolicyConfigReader,
} from "../../prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { prepareAgentPromptProjects } from "../../prompt-projects.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import {
  bindRunToPreparedModelRuntime,
  prepareRunModelRuntimeProjects,
} from "./prepared-runtime-context.js";

vi.mock("../../prompt-projects.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prompt-projects.js")>()),
  prepareAgentPromptProjects: vi.fn(),
}));

it("preserves the private admitted policy reader when capturing turn projects", async () => {
  const run = { sessionId: "project-turn" } as RunEmbeddedAgentParamsWithSessionFile;
  const snapshot = { config: {} } as PreparedModelRuntimeSnapshot;
  const readPolicyConfig = () => snapshot.config;
  const projects = { repoRoot: null, projectKey: null, activeProjectKeys: [] };
  vi.mocked(prepareAgentPromptProjects).mockResolvedValueOnce(projects);
  bindPreparedModelRuntimeAuth(snapshot, { readPolicyConfig });

  const prepared = await prepareRunModelRuntimeProjects(run, snapshot);

  expect(prepareAgentPromptProjects).toHaveBeenCalledWith(run);
  expect(prepared).toEqual({ ...snapshot, ...projects });
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(getPreparedModelRuntimePolicyConfigReader(prepared)).toBe(readPolicyConfig);
});

describe("bindRunToPreparedModelRuntime", () => {
  it("replaces queued config and directories with one committed generation", () => {
    const requestedConfig = { logging: { level: "info" as const } };
    const committedConfig = { logging: { level: "debug" as const } };
    const runParams = {
      runId: "run-1",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      prompt: "hello",
      config: requestedConfig,
      agentId: "requested-agent",
      agentDir: "/tmp/requested-agent",
      workspaceDir: "/tmp/requested-workspace",
    } as RunEmbeddedAgentParamsWithSessionFile;
    const preparedModelRuntime = {
      agentId: "committed-agent",
      agentDir: "/tmp/committed-agent",
      workspaceDir: "/tmp/committed-workspace",
      config: committedConfig,
    } as PreparedModelRuntimeSnapshot;

    const result = bindRunToPreparedModelRuntime({
      runParams,
      requestedWorkspaceResolution: {
        agentId: "requested-agent",
        workspaceDir: "/tmp/requested-workspace",
        usedFallback: true,
        isCanonicalWorkspace: true,
        fallbackReason: "missing",
      },
      preparedModelRuntime,
    });

    expect(result.runParams).toEqual(
      expect.objectContaining({
        agentId: "committed-agent",
        agentDir: "/tmp/committed-agent",
        config: committedConfig,
        workspaceDir: "/tmp/committed-workspace",
      }),
    );
    expect(result.workspaceResolution).toEqual({
      agentId: "committed-agent",
      workspaceDir: "/tmp/committed-workspace",
      usedFallback: true,
      isCanonicalWorkspace: true,
      fallbackReason: "missing",
    });
  });
});
