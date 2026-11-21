import { expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  mockParams,
  useContextEngineAttemptHarness,
} from "./attempt-context-engine.test-support.js";

const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:final-system-prompt");

it("passes hook-enriched system context to admission before blocking model submission", async () => {
  const marker = "FINAL_SYSTEM_PROMPT_CONTEXT";
  const beforeAgentRun = vi.fn(async () => ({
    outcome: "block" as const,
    reason: "Blocked by test policy.",
  }));
  hoisted.getGlobalHookRunnerMock.mockReturnValue(
    createHookRunnerWithRegistry([
      { hookName: "before_prompt_build", handler: async () => ({ prependSystemContext: marker }) },
      { hookName: "before_agent_run", pluginId: "test-policy", handler: beforeAgentRun },
    ]).runner,
  );
  const sessionPrompt = vi.fn(async () => {
    throw new Error("blocked prompt must not reach the model");
  });

  const result = await runAttempt({ sessionPrompt });

  expect(mockParams(beforeAgentRun).systemPrompt).toEqual(expect.stringContaining(marker));
  expect(sessionPrompt).not.toHaveBeenCalled();
  expect(result.finalPromptText).toBeUndefined();
  expect(projectAgentRunAttemptTerminal(result.terminal).promptErrorSource).toBe(
    "hook:before_agent_run",
  );
});
