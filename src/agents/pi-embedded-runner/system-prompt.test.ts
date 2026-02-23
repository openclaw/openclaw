import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

function createMockSession() {
  const setSystemPrompt = vi.fn();
  const session = {
    agent: { setSystemPrompt },
  } as unknown as AgentSession;
  return { session, setSystemPrompt };
}

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const prompt = "You are a helpful assistant with custom context.";

    applySystemPromptOverrideToSession(session, prompt);

    expect(setSystemPrompt).toHaveBeenCalledWith(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { session, setSystemPrompt } = createMockSession();

    applySystemPromptOverrideToSession(session, "  padded prompt  ");

    expect(setSystemPrompt).toHaveBeenCalledWith("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const override = createSystemPromptOverride("function-based prompt");

    applySystemPromptOverrideToSession(session, override);

    expect(setSystemPrompt).toHaveBeenCalledWith("function-based prompt");
  });
});
