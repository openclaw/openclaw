import { afterEach, describe, expect, it } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("retains an empty prompt range without hooks", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
    });

    expect(result).toEqual({
      prompt: "",
      developerInstructions: "base instructions",
      promptInputRange: { start: 0, end: 0 },
    });
  });

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
      promptInputRange: { start: 16, end: 21 },
    });
  });

  it("keeps an empty input range between prepended and appended context", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
      beforeAgentStartResult: {
        appendContext: "appended context",
        prependContext: "prepended context",
      },
    });

    expect(result).toEqual({
      prompt: "prepended context\n\nappended context",
      developerInstructions: "base instructions",
      promptInputRange: { start: 17, end: 17 },
    });
  });
});
