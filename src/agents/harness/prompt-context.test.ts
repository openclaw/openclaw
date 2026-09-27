import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentWorkspaceMemoryRouting,
  shouldIncludeAgentHarnessRuntimeContext,
} from "./prompt-context.js";

describe("harness runtime context inclusion", () => {
  it.each([
    { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "cron", included: false },
    { bootstrapContextMode: "full", bootstrapContextRunKind: "cron", included: true },
    { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "heartbeat", included: true },
    { bootstrapContextMode: undefined, bootstrapContextRunKind: undefined, included: true },
  ] as const)("$bootstrapContextMode / $bootstrapContextRunKind", ({ included, ...params }) => {
    expect(shouldIncludeAgentHarnessRuntimeContext(params)).toBe(included);
  });
});

describe("harness workspace memory routing", () => {
  const workspaceDir = path.resolve("workspace-memory-fixture");
  const config = { agents: { defaults: { workspace: workspaceDir } } };

  it.each([
    {
      toolNames: ["memory_get", "memory_search"],
      memoryToolNames: ["memory_search", "memory_get"],
      memoryToolRouted: true,
    },
    { toolNames: ["memory_get"], memoryToolNames: ["memory_get"], memoryToolRouted: true },
    { toolNames: ["message"], memoryToolNames: [], memoryToolRouted: false },
  ])(
    "selects admitted memory tools from $toolNames",
    ({ toolNames, memoryToolNames, memoryToolRouted }) => {
      expect(
        resolveAgentWorkspaceMemoryRouting({
          config,
          agentId: "main",
          workspaceDir: path.join(workspaceDir, "nested", ".."),
          toolNames: new Set(toolNames),
        }),
      ).toEqual({ memoryToolNames, memoryToolRouted });
    },
  );

  it.each([
    {
      name: "another workspace",
      config,
      agentId: "main",
      workspaceDir: path.join(workspaceDir, "sandbox"),
    },
    { name: "missing configuration", config: undefined, agentId: "main", workspaceDir },
    { name: "missing agent identity", config, agentId: undefined, workspaceDir },
  ])(
    "preserves inline memory for $name",
    ({ config: caseConfig, agentId, workspaceDir: caseWorkspaceDir }) => {
      expect(
        resolveAgentWorkspaceMemoryRouting({
          config: caseConfig,
          agentId,
          workspaceDir: caseWorkspaceDir,
          toolNames: new Set(["memory_search"]),
        }),
      ).toEqual({ memoryToolNames: ["memory_search"], memoryToolRouted: false });
    },
  );
});
