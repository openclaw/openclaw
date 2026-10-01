import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createWorkerPlacementTools } from "../worker/worker-placement-tools.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import * as coreCodingTools from "./core-coding-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { prepareCoreToolPolicy, projectAgentToolDefinition } from "./prepared-tool-surface.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "preserves local definition bytes and policy for placement (deny process=%s)",
  (denyProcess) => {
    const construct = vi.spyOn(coreCodingTools, "createCoreCodingTools");
    const options = {
      workspaceDir: tempDirs.make("prepared-surface-assembly-"),
      config: { tools: { deny: ["write", ...(denyProcess ? ["process"] : [])] } },
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
      const openClawCalls = vi.mocked(createOpenClawTools).mock.calls.length;
      createOpenClawCodingToolsInternal(
        { ...options, toolConstructionPlan: undefined },
        undefined,
        undefined,
        { tools: prepared, policy },
      );
      expect(construct).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createOpenClawTools).mock.calls).toHaveLength(openClawCalls);
    } finally {
      construct.mockRestore();
    }
  },
);
