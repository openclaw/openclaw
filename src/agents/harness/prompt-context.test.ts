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
  ] as const)("$bootstrapContextMode / $bootstrapContextRunKind", ({ included, ...params }) => {
    expect(shouldIncludeAgentHarnessRuntimeContext(params)).toBe(included);
  });
});

describe("harness workspace memory routing", () => {
  const workspaceDir = path.resolve("workspace-memory-fixture");
  const config = { agents: { defaults: { workspace: workspaceDir } } };

  it.each([
    [["memory_get", "memory_search"], ["memory_search", "memory_get"], true, "normalized"],
    [["message"], [], false, "normalized"],
    [["memory_search"], ["memory_search"], false, "other workspace"],
    [["memory_search"], ["memory_search"], false, "missing config"],
    [["memory_search"], ["memory_search"], false, "missing agent"],
  ] as const)("routes %j with %s / %s / %s", (tools, memoryToolNames, memoryToolRouted, scope) => {
    expect(
      resolveAgentWorkspaceMemoryRouting({
        config: scope === "missing config" ? undefined : config,
        agentId: scope === "missing agent" ? undefined : "main",
        workspaceDir: path.join(
          workspaceDir,
          ...(scope === "other workspace" ? ["sandbox"] : ["nested", ".."]),
        ),
        toolNames: new Set(tools),
      }),
    ).toEqual({ memoryToolNames, memoryToolRouted });
  });
});
