import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async () => {
      const tool = {
        name: "fake__show",
        description: "Late requester-scoped tool.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }),
      };
      return { tools: [tool], advertisedTools: [tool], dispose: async () => undefined };
    },
  };
});

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt tool inheritance", () => {
  it.each([true, false])(
    "captures final executable tools only when parent policy is restrictive (%s)",
    async (restricted) => {
      const sessionFile = path.join(tempDir, "session-tool-inheritance.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace-tool-inheritance"));
      setCodexTestModelSupportsTools(params, true);
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.toolsAllow = ["read", "sessions_spawn", "fake__show"];
      if (restricted) {
        params.config = { ...params.config, tools: { allow: params.toolsAllow } };
      }
      const host = params.hostCapabilities;
      const snapshots: Array<{ ref?: string[]; initial: string[] }> = [];
      params.hostCapabilities = Object.freeze({
        ...host,
        createToolSurface: (options, bindingOptions) => {
          const tools = host.createToolSurface!(options, bindingOptions);
          snapshots.push({
            ref: options.inheritedToolAllowlistRef,
            initial: [...(options.inheritedToolAllowlistRef ?? [])],
          });
          return tools;
        },
      });
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
          codexDynamicToolsExclude: ["read"],
        },
      });
      await harness.waitForMethod("turn/start");
      // Finish the attempt before assertions so a regression cannot leave a pending run.
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.ref).toBeUndefined();
      expect(snapshots[0]?.ref).toBeDefined();
      if (restricted) {
        expect(snapshots[0]?.initial).toEqual(expect.arrayContaining(["read", "sessions_spawn"]));
        expect(snapshots[0]?.initial).not.toContain("fake__show");
        expect(snapshots[0]?.ref?.toSorted()).toEqual(["fake__show", "sessions_spawn"]);
      } else {
        expect(snapshots[0]?.initial).toEqual([]);
        expect(snapshots[0]?.ref).toEqual([]);
      }
    },
  );
});
