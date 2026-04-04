import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

type MutableSession = {
  _baseSystemPrompt?: string;
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
};

type MockSession = MutableSession & {
  agent: {
    state: {
      systemPrompt?: string;
    };
  };
};

function createMockSession(): {
  session: MockSession;
} {
  const session = {
    agent: { state: {} },
  } as MockSession;
  return { session };
}

function applyAndGetMutableSession(
  prompt: Parameters<typeof applySystemPromptOverrideToSession>[1],
) {
  const { session } = createMockSession();
  applySystemPromptOverrideToSession(session as unknown as AgentSession, prompt);
  return {
    mutable: session,
  };
}

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const prompt = "You are a helpful assistant with custom context.";
    const { mutable } = applyAndGetMutableSession(prompt);

    expect(mutable.agent.state.systemPrompt).toBe(prompt);
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { mutable } = applyAndGetMutableSession("  padded prompt  ");

    expect(mutable.agent.state.systemPrompt).toBe("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const override = createSystemPromptOverride("function-based prompt");
    const { mutable } = applyAndGetMutableSession(override);

    expect(mutable.agent.state.systemPrompt).toBe("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { mutable } = applyAndGetMutableSession("rebuild test");
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});
