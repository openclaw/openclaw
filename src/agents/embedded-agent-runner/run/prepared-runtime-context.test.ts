import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../../../plugins/plugin-metadata-empty.test-support.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import type { PreparedModelRuntimePluginGeneration } from "../../prepared-model-runtime.types.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import {
  bindRunToPreparedModelRuntime,
  resolvePreparedRuntimeWorkspaces,
} from "./prepared-runtime-context.js";

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

describe("resolvePreparedRuntimeWorkspaces", () => {
  function fixture() {
    const workspaceDir = "/tmp/model-inventory-workspace";
    const executionWorkspace = "/tmp/actual-execution-workspace";
    const agentDir = "/tmp/prepared-workspace-agent";
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir, agentDir } } },
    };
    const generation: PreparedModelRuntimePluginGeneration = {
      remoteCatalog: null,
      pluginMetadataSnapshot: createEmptyPluginMetadataSnapshot(workspaceDir),
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    };
    const snapshot = {
      config,
      agentId: "main",
      agentDir,
      workspaceDir,
    } as PreparedModelRuntimeSnapshot;
    const params = {
      runId: "prepared-workspace-run",
      sessionId: "prepared-workspace-session",
      sessionFile: "/tmp/prepared-workspace-session.jsonl",
      prompt: "hello",
      config: structuredClone(config),
      agentId: "main",
      agentDir,
      workspaceDir: executionWorkspace,
      pluginGeneration: generation,
    } as RunEmbeddedAgentParamsWithSessionFile;
    return { workspaceDir, executionWorkspace, config, generation, snapshot, params };
  }

  it("retains admitted inventory for a canonical config clone without moving execution", () => {
    const f = fixture();
    withPreparedModelRuntimePluginGenerationScope(
      f.generation,
      () => {
        const result = resolvePreparedRuntimeWorkspaces(f.params);
        expect(result.runtimeWorkspaceResolution.workspaceDir).toBe(f.workspaceDir);
        expect(result.requestedWorkspaceResolution.workspaceDir).toBe(f.executionWorkspace);
        expect(result.preserveExecutionWorkspace).toBe(true);
        expect(
          bindRunToPreparedModelRuntime({
            runParams: f.params,
            requestedWorkspaceResolution: result.requestedWorkspaceResolution,
            preserveExecutionWorkspace: result.preserveExecutionWorkspace,
            preparedModelRuntime: f.snapshot,
          }).workspaceResolution.workspaceDir,
        ).toBe(f.executionWorkspace);
      },
      () => f.snapshot,
    );
  });

  it.each([
    "projected config",
    "foreign agent",
    "foreign directory",
    "foreign generation",
    "metadata replacement",
    "retired lease",
    "read-only probe",
  ] as const)("does not borrow admitted inventory for %s", (scope) => {
    const f = fixture();
    const params = { ...f.params };
    if (scope === "projected config") {
      params.config = { ...f.config, tools: { profile: "full" } };
    }
    if (scope === "foreign agent") {
      params.agentId = "other";
    }
    if (scope === "foreign directory") {
      params.agentDir = "/tmp/foreign-workspace-agent";
    }
    if (scope === "foreign generation") {
      params.pluginGeneration = { ...f.generation };
    }
    if (scope === "metadata replacement") {
      params.pluginGeneration = {
        ...f.generation,
        pluginMetadataSnapshot: createEmptyPluginMetadataSnapshot(f.workspaceDir),
      };
    }
    if (scope === "read-only probe") {
      params.preparedModelRuntimeMode = "isolated-read-only";
    }
    withPreparedModelRuntimePluginGenerationScope(
      f.generation,
      () => {
        if (scope === "foreign agent") {
          expect(() => resolvePreparedRuntimeWorkspaces(params)).toThrow(
            "not present in the configured roster",
          );
          return;
        }
        const result = resolvePreparedRuntimeWorkspaces(params);
        expect(result.runtimeWorkspaceResolution.workspaceDir).toBe(f.executionWorkspace);
        expect(result.preserveExecutionWorkspace).toBe(false);
      },
      () => (scope === "retired lease" ? undefined : f.snapshot),
    );
  });
});
