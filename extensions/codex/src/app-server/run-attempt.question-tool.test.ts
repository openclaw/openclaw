import path from "node:path";
import { describe, expect, it } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex executable question ownership", () => {
  it.each([true, false])(
    "uses current Ask User availability rather than its retained declaration (%s)",
    async (available) => {
      const harness = createStartedThreadHarness();
      const params = createParams(path.join(tempDir, "questions.jsonl"), tempDir);
      setCodexTestModelSupportsTools(params, true);
      const askUser = createRuntimeDynamicTool("ask_user");
      setCodexTestToolFactory(params, () => [askUser]);
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.runtimePlan.tools.normalize = (tools) => (available ? tools : []);
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      const start = harness.requests.find((request) => request.method === "thread/start")
        ?.params as {
        dynamicTools: CodexDynamicToolSpec[];
        config: Record<string, unknown>;
      };
      expect(
        flattenCodexDynamicToolFunctions(start.dynamicTools).map((tool) => tool.name),
      ).toContain("ask_user");
      expect(start.config["tools.experimental_request_user_input.enabled"]).toBe(
        available ? false : undefined,
      );
      const response = await harness.handleServerRequest({
        id: "question-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "ask-1",
          tool: "ask_user",
          arguments: {},
        },
      });
      expect(response).toMatchObject({ success: available });
      if (available) {
        expect(askUser.execute).toHaveBeenCalledOnce();
      } else {
        expect(askUser.execute).not.toHaveBeenCalled();
        expect(response).toMatchObject({
          contentItems: [
            { type: "inputText", text: "OpenClaw tool is not available for this turn: ask_user" },
          ],
        });
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    },
  );
});
