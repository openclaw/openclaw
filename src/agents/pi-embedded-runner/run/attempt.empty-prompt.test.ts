import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

describe("runEmbeddedAttempt empty prompt guard", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  it("skips provider submission when prompt, history, and images are empty", async () => {
    const sessionPrompt = vi.fn(async () => {});
    const { assemble } = createContextEngineBootstrapAndAssemble();

    const result = await createContextEngineAttemptRunner({
      contextEngine: { assemble },
      sessionKey: "agent:main:guildchat:dm:empty-prompt",
      tempPaths,
      sessionMessages: [],
      sessionPrompt,
      attemptOverrides: {
        prompt: "   ",
      },
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.promptError).toBeNull();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.messagesSnapshot).toEqual([]);
    expect(result.assistantTexts).toEqual([]);
  });

  it("still submits a blank prompt when replay history has content", async () => {
    const sessionPrompt = vi.fn(async () => {});
    const { assemble } = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: "previous turn", timestamp: 1 },
    ] as AgentMessage[];

    await createContextEngineAttemptRunner({
      contextEngine: { assemble },
      sessionKey: "agent:main:guildchat:dm:empty-prompt-with-history",
      tempPaths,
      sessionMessages,
      sessionPrompt,
      attemptOverrides: {
        prompt: "   ",
      },
    });

    expect(sessionPrompt).toHaveBeenCalledTimes(1);
  });
});
