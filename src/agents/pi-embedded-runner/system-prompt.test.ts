import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

type MutableSystemPromptFields = {
  _baseSystemPrompt?: string;
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
};

function createMockSession() {
  const setSystemPrompt = vi.fn();
  const session = {
    agent: { setSystemPrompt },
  } as unknown as AgentSession;
  return { session, setSystemPrompt };
}

function applyAndGetMutableSession(
  prompt: Parameters<typeof applySystemPromptOverrideToSession>[1],
) {
  const { session, setSystemPrompt } = createMockSession();
  applySystemPromptOverrideToSession(session, prompt);
  return {
    mutable: session as unknown as MutableSystemPromptFields,
    setSystemPrompt,
  };
}

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const prompt = "You are a helpful assistant with custom context.";
    const { mutable, setSystemPrompt } = applyAndGetMutableSession(prompt);

    expect(setSystemPrompt).toHaveBeenCalledWith(prompt);
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { setSystemPrompt } = applyAndGetMutableSession("  padded prompt  ");

    expect(setSystemPrompt).toHaveBeenCalledWith("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const override = createSystemPromptOverride("function-based prompt");
    const { setSystemPrompt } = applyAndGetMutableSession(override);

    expect(setSystemPrompt).toHaveBeenCalledWith("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { mutable } = applyAndGetMutableSession("rebuild test");
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});
