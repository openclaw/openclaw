import { describe, expect, it } from "vitest";
import {
  resolveLiveCompletionSessionId,
  resolveLiveSystemPrompt,
} from "./live-model-session-id.js";

describe("resolveLiveCompletionSessionId", () => {
  it("gives direct provider probes a stable routing identity", () => {
    expect(resolveLiveCompletionSessionId({ provider: "opencode-go", id: "kimi-k3" })).toBe(
      "models-profiles-live:opencode-go:kimi-k3",
    );
  });

  it("adds instructions only for OpenAI probes", () => {
    expect(resolveLiveSystemPrompt({ provider: "openai" })).toContain(
      "Follow the user's instruction exactly.",
    );
    expect(resolveLiveSystemPrompt({ provider: "ollama" })).toBeUndefined();
  });
});
