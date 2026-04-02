import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

type MutableSession = {
  _baseSystemPrompt?: string;
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
};

type MockSession = MutableSession & {
  agent: {
    setSystemPrompt: ReturnType<typeof vi.fn>;
  };
};

function createMockSession(): {
  session: MockSession;
  setSystemPrompt: ReturnType<typeof vi.fn>;
} {
  const setSystemPrompt = vi.fn<(prompt: string) => void>();
  const session = {
    agent: { setSystemPrompt },
  } as MockSession;
  return { session, setSystemPrompt };
}

function applyAndGetMutableSession(
  prompt: Parameters<typeof applySystemPromptOverrideToSession>[1],
) {
  const { session, setSystemPrompt } = createMockSession();
  applySystemPromptOverrideToSession(session as unknown as AgentSession, prompt);
  return {
    mutable: session,
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
