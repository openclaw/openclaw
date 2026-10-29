import { describe, expect, it, vi } from "vitest";
import { withPreparedModelRuntimePluginGenerationScope } from "../../prepared-model-runtime-generation-scope.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "../../prepared-model-runtime.types.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import { resolvePreparedRuntimeWorkspaces } from "./prepared-runtime-context.js";

// mock-isolation: The borrowed generation is deliberately not the process-wide current plugin generation.
vi.mock("../../../plugins/current-plugin-metadata-snapshot.js", () => ({
  isCurrentPluginMetadataSnapshotRuntimeGeneration: () => false,
}));
// mock-isolation: Borrowed inventory comes from the injected snapshot, never filesystem plugin discovery.
vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => ({}),
}));

describe("borrowed prepared inventory workspace", () => {
  const config = {
    agents: {
      entries: {
        main: { workspace: "/tmp/borrow-canonical" },
        other: { workspace: "/tmp/other-canonical" },
      },
      defaults: { workspace: "/tmp/borrow-canonical", model: { primary: "openai/model-a" } },
    },
  };
  const generation = {} as PreparedModelRuntimePluginGeneration;
  const snapshot = {
    config,
    agentId: "main",
    agentDir: "/tmp/borrow-agent",
    workspaceDir: "/tmp/borrow-inventory",
  } as unknown as PreparedModelRuntimeSnapshot;
  const params = () =>
    ({
      config: structuredClone(config),
      agentId: "main",
      agentDir: snapshot.agentDir,
      workspaceDir: "/tmp/borrow-execution",
      pluginGeneration: generation,
    }) as unknown as RunEmbeddedAgentParamsWithSessionFile;
  const resolve = (input: RunEmbeddedAgentParamsWithSessionFile) =>
    withPreparedModelRuntimePluginGenerationScope(
      generation,
      () => resolvePreparedRuntimeWorkspaces(input),
      () => snapshot,
    );
  it("borrows equivalent projected configs without changing the execution directory", () => {
    const input = params();
    expect(input.config).not.toBe(config);
    const result = resolve(input);
    expect(result.runtimeWorkspaceResolution.workspaceDir).toBe(snapshot.workspaceDir);
    expect(result.requestedWorkspaceResolution.workspaceDir).toBe(input.workspaceDir);
    expect(result.preserveExecutionWorkspace).toBe(true);
  });
  it.each(["config", "agent", "agentDir", "isolated", "missing-config"])(
    "does not widen %s",
    (kind) => {
      const input = params();
      if (kind === "config") {
        input.config = structuredClone(config);
        input.config.agents!.defaults!.model = { primary: "openai/model-b" };
      }
      if (kind === "agent") {
        input.agentId = "other";
      }
      if (kind === "agentDir") {
        input.agentDir = "/tmp/other-agent";
      }
      if (kind === "isolated") {
        input.preparedModelRuntimeMode = "isolated-read-only";
      }
      if (kind === "missing-config") {
        input.config = undefined;
        expect(() => resolve(input)).toThrow("No agents configured");
        return;
      }
      expect(resolve(input).runtimeWorkspaceResolution.workspaceDir).not.toBe(
        snapshot.workspaceDir,
      );
    },
  );
});
