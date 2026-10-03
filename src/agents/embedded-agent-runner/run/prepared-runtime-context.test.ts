import { describe, expect, it } from "vitest";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { rootedAgentRunParams } from "../../rooted-run-params.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import { bindRunToPreparedModelRuntime } from "./prepared-runtime-context.js";

describe("bindRunToPreparedModelRuntime", () => {
  it("adopts the committed generation without moving a rooted execution boundary", () => {
    const rooted = rootedAgentRunParams("/tmp/bootstrap", "/tmp/task");
    const config = { logging: { level: "debug" as const } };
    const result = bindRunToPreparedModelRuntime({
      runParams: {
        ...rooted,
        runId: "rooted",
        sessionId: "rooted",
        prompt: "review",
      } as RunEmbeddedAgentParamsWithSessionFile,
      requestedWorkspaceResolution: {
        workspaceDir: "/tmp/task",
        agentId: "main",
        agentIdSource: "explicit",
        isCanonicalWorkspace: false,
        usedFallback: false,
      },
      preserveExecutionWorkspace: true,
      preparedModelRuntime: {
        agentId: "main",
        agentDir: "/tmp/committed-agent",
        workspaceDir: "/tmp/reloaded-workspace",
        config,
      } as PreparedModelRuntimeSnapshot,
    });
    expect(result.runParams).toMatchObject({ ...rooted, config, agentDir: "/tmp/committed-agent" });
    expect(result.workspaceResolution.workspaceDir).toBe("/tmp/task");
  });

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
        agentIdSource: "explicit",
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
      agentIdSource: "explicit",
      workspaceDir: "/tmp/committed-workspace",
      usedFallback: true,
      isCanonicalWorkspace: true,
      fallbackReason: "missing",
    });
  });
});
