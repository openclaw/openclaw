// Architecture guards for the shared AssistantMessage contract used by
// openclaw/plugin-sdk/llm. New failure metadata must be representable in this
// shape so transports and runners can communicate refusal / diagnostic state.
import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageDiagnostic } from "./types.js";

describe("AssistantMessage failure metadata (#98976)", () => {
  it("preserves errorCode and diagnostics fields", () => {
    const diagnostic: AssistantMessageDiagnostic = {
      type: "provider_refusal",
      timestamp: Date.now(),
      details: { provider: "anthropic", category: "bio" },
    };

    const message = {
      role: "assistant",
      content: [{ type: "text" as const, text: "partial" }],
      api: "openai-responses" as const,
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage: "Anthropic refusal",
      errorCode: "provider_refusal",
      diagnostics: [diagnostic],
      timestamp: Date.now(),
    } satisfies AssistantMessage;

    expect(message.errorCode).toBe("provider_refusal");
    expect(message.diagnostics).toEqual([diagnostic]);
  });
});
