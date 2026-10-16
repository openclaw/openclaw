import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createWorkerPlacementTools } from "../worker/worker-placement-tools.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import * as coreCodingTools from "./core-coding-tools.js";
import { prepareCoreToolPolicy, projectAgentToolDefinition } from "./prepared-tool-surface.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "preserves local definition bytes and policy for placement (deny process=%s)",
  (denyProcess) => {
    const construct = vi.spyOn(coreCodingTools, "createCoreCodingTools");
    const options = {
      workspaceDir: tempDirs.make("prepared-surface-assembly-"),
      config: {
        tools: {
          exec: { host: "gateway" as const },
          deny: ["write", ...(denyProcess ? ["process"] : [])],
        },
      },
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    };
    try {
      const local = createOpenClawCodingToolsInternal(options);
      const policy = prepareCoreToolPolicy(options);
      const prepared = createWorkerPlacementTools({
        policy,
        cwd: options.workspaceDir,
        containmentRoot: options.workspaceDir,
        execAuthority: { host: "gateway", security: "full", ask: "off" },
        agentId: "main",
        sessionKey: "worker:prepared",
        sessionId: "prepared",
        runId: "run-prepared",
      });
      expect(prepared.map((tool) => tool.name)).toContain("write");
      const placed = createOpenClawCodingToolsInternal(options, undefined, undefined, {
        tools: prepared,
        policy,
      });
      expect(construct).toHaveBeenCalledTimes(2);
      expect(placed.map((tool) => tool.name)).not.toContain("write");
      expect(JSON.stringify(placed.map(projectAgentToolDefinition))).toBe(
        JSON.stringify(local.map(projectAgentToolDefinition)),
      );
    } finally {
      construct.mockRestore();
    }
  },
);

it("retains Gateway tools while replacing a placed session tool's schema and execution", async () => {
  const options = {
    workspaceDir: tempDirs.make("prepared-surface-gateway-"),
    config: {},
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  };
  const result = { content: [], details: { childSessionKey: "placed-child" } };
  const execute = vi.fn<AnyAgentTool["execute"]>().mockResolvedValue(result);
  const adapter: AnyAgentTool = {
    name: "sessions_spawn",
    label: "Placed spawn",
    description: "Create a placed child",
    parameters: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
    execute,
  };
  const tools = createOpenClawCodingToolsInternal(options, undefined, undefined, {
    tools: [adapter],
    policy: prepareCoreToolPolicy(options),
  });
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("web_fetch");
  expect(names).toContain("sessions_list");
  expect(names.filter((name) => name === "sessions_spawn")).toHaveLength(1);
  const spawn = tools.find((tool) => tool.name === "sessions_spawn");
  if (!spawn) {
    throw new Error("Expected the placed spawn adapter");
  }
  expect(spawn.parameters).toMatchObject(adapter.parameters);
  expect(spawn.parameters).not.toHaveProperty("properties.action");
  await expect(spawn.execute("spawn-placed", { task: "synthetic task" })).resolves.toEqual(result);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith("spawn-placed", { task: "synthetic task" });
});
