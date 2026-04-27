import { describe, expect, it, vi } from "vitest";

vi.mock("../../model-auth.js", () => ({
  applyAuthHeaderOverride: vi.fn((model) => model),
  applyLocalNoAuthHeaderOverride: vi.fn((model) => model),
}));

vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: vi.fn(() => ({ kind: "runtime-plan-test-double" })),
}));

import {
  buildAttemptPrompt,
  buildEmbeddedRunAttemptInput,
  resolveAttemptStreamApiKey,
} from "./runtime-plan-factory.js";

describe("runtime-plan-factory", () => {
  it("keeps prompts unchanged when no retry instructions are present", () => {
    expect(
      buildAttemptPrompt({
        provider: "openai",
        prompt: "hello",
        instructions: {},
      }),
    ).toBe("hello");
  });

  it("appends only non-empty retry instructions in execution order", () => {
    expect(
      buildAttemptPrompt({
        provider: "openai",
        prompt: "base",
        instructions: {
          ackExecutionFastPathInstruction: "ack",
          planningOnlyRetryInstruction: "   ",
          reasoningOnlyRetryInstruction: "reasoning",
          emptyResponseRetryInstruction: "empty",
        },
      }),
    ).toBe("base\n\nack\n\nreasoning\n\nempty");
  });

  it("does not inject the pre-exchange api key after runtime auth takes over", () => {
    expect(
      resolveAttemptStreamApiKey({
        runtimeAuthState: { kind: "runtime-auth" } as never,
        apiKeyInfo: { apiKey: "secret" } as never,
      }),
    ).toBeUndefined();
  });

  it("uses the resolved api key when runtime auth did not replace credentials", () => {
    expect(
      resolveAttemptStreamApiKey({
        runtimeAuthState: null,
        apiKeyInfo: { apiKey: "secret" } as never,
      }),
    ).toBe("secret");
  });

  it("uses active session identifiers when building retry attempt input", () => {
    const attempt = buildEmbeddedRunAttemptInput({
      runParams: {
        prompt: "hello",
        sessionId: "original-session",
        sessionFile: "/tmp/original-session.jsonl",
      } as never,
      activeSessionId: "rotated-session",
      activeSessionFile: "/tmp/rotated-session.jsonl",
      resolvedSessionKey: "session-key",
      resolvedWorkspace: "/tmp/workspace",
      agentDir: "/tmp/agent",
      agentId: "agent-id",
      isCanonicalWorkspace: true,
      contextEngine: undefined as never,
      provider: "openai",
      modelId: "gpt-5.4",
      effectiveModel: { id: "gpt-5.4", api: "openai", provider: "openai" } as never,
      harnessId: "pi",
      pluginHarnessOwnsTransport: false,
      apiKeyInfo: null,
      runtimeAuthState: null,
      authStorage: undefined as never,
      modelRegistry: undefined as never,
      legacyBeforeAgentStartResult: undefined as never,
      thinkLevel: "medium" as never,
      resolvedToolResultFormat: "default" as never,
      bootstrapPromptWarningSignaturesSeen: [],
      instructions: {},
    });

    expect(attempt.sessionId).toBe("rotated-session");
    expect(attempt.sessionFile).toBe("/tmp/rotated-session.jsonl");
  });
});
