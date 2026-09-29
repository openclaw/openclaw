import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];
beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  tempPaths.length = 0;
});

describe("settled post-tool turn finalization context", () => {
  it.each([
    { message: "terminated", captures: true },
    { message: "the request was terminated by the server", captures: false },
  ])("captures a final provider failure '$message'=$captures", async ({ message, captures }) => {
    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:settled",
      tempPaths,
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          {
            role: "assistant",
            stopReason: "toolUse",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            isError: false,
            timestamp: 3,
            content: [{ type: "text", text: "file contents" }],
          },
        ];
        throw new Error(message);
      },
    });
    expect(result.terminal.kind).toBe("failed");
    expect(result.assistantTexts.every((text) => !text.trim())).toBe(true);
    const context = result.settledTurnFinalizationContext;
    if (!captures) {
      expect(context).toBeUndefined();
      return;
    }
    if (context?.source !== "openclaw-transcript") {
      throw new Error("Expected the built-in settled transcript context");
    }
    expect(context.messages.some((entry) => entry.role === "toolResult")).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
  });
});
