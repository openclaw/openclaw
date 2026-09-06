import { describe, expect, it, vi } from "vitest";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";

describe("attempt transcript cleanup", () => {
  it("keeps live messages unchanged when the durable suffix fence rejects cleanup", () => {
    const user = { role: "user", content: "question" };
    const precheckError = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
    };
    const messages = [user, precheckError];
    const fenceError = new Error("concurrent transcript append");
    const removeTrailingEntries = vi.fn(() => {
      throw fenceError;
    });
    const activeSession = { agent: { state: { messages } } };

    expect(() =>
      removeTrailingMidTurnPrecheckAssistantError({
        activeSession: activeSession as never,
        sessionManager: { removeTrailingEntries } as never,
      }),
    ).toThrow(fenceError);

    expect(activeSession.agent.state.messages).toBe(messages);
    expect(activeSession.agent.state.messages).toEqual([user, precheckError]);
  });
});
