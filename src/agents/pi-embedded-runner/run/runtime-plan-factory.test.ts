import { describe, expect, it } from "vitest";
import { buildAttemptPrompt, resolveAttemptStreamApiKey } from "./runtime-plan-factory.js";

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
});
