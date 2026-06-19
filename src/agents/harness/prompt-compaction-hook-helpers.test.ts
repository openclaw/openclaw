import { afterEach, describe, expect, it } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("uses precomputed agent-start context without a global hook runner", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {
        agentId: "agent-1",
        sessionKey: "session-1",
        workspaceDir: "/workspace",
      },
      beforeAgentStartResult: {
        prependContext: "cached context",
        systemPrompt: "cached instructions",
      },
    });

    expect(result).toEqual({
      prompt: "cached context\n\nhello",
      developerInstructions: "cached instructions",
    });
  });
});
