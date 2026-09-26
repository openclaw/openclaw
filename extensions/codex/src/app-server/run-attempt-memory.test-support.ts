import path from "node:path";
import { registerMemoryCapability } from "openclaw/plugin-sdk/memory-host-core";
import { expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";

/** Exercise memory-provider delivery under the attempt suite's shared runtime and cleanup. */
export function registerCodexMemoryInstructionTests() {
  it.each([false, true])(
    "delivers provider-native memory guidance at turn/start (legacy tools: %s)",
    async (includeLegacyTools) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const providerPrompt = "## Provider Memory\nUse knowledge_lookup to recall durable facts.";
      const promptBuilder = vi.fn(({ availableTools }: { availableTools: Set<string> }) =>
        availableTools.has("knowledge_lookup") ? [providerPrompt] : [],
      );
      registerMemoryCapability("knowledge", { promptBuilder });
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      setAgentWorkspaceForTest(params, workspaceDir);
      setCodexTestToolFactory(params, () => [
        createRuntimeDynamicTool("knowledge_lookup"),
        createRuntimeDynamicTool("knowledge_save_page"),
        createRuntimeDynamicTool("lcm_grep"),
        ...(includeLegacyTools
          ? [createRuntimeDynamicTool("memory_search"), createRuntimeDynamicTool("memory_get")]
          : []),
      ]);
      params.disableTools = false;
      setCodexTestModelSupportsTools(params, true);
      params.runtimePlan = createCodexRuntimePlanFixture();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const request = turnStart?.params as {
        collaborationMode?: { settings?: { developer_instructions?: string | null } };
      };
      expect(request.collaborationMode?.settings?.developer_instructions).toContain(providerPrompt);
      const availableTools = promptBuilder.mock.calls.at(-1)?.[0].availableTools;
      expect(availableTools?.has("knowledge_lookup")).toBe(true);
      expect(availableTools?.has("knowledge_save_page")).toBe(true);
      expect(availableTools?.has("lcm_grep")).toBe(true);
      expect(availableTools?.has("knowledge_withdraw")).toBe(false);
    },
  );
}
