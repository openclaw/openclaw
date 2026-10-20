import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  assistantAttempt,
  expectComplete,
  emptyAssistant,
  resolveTerminal,
  resolveTerminalText,
} from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

describe("terminal auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGeneratedMediaTaskActivityForTests();
  });

  it("reports the successful profile privately for command maintenance", async () => {
    const authProfileId = "openai:selected";
    const text = "The turn completed.";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const attempt = assistantAttempt(assistant, {
      assistantTexts: [text],
    });
    const onSuccessfulAuthProfile = vi.fn();
    const resolved = await resolveTerminal({
      attempt,
      attemptAssistant: assistant,
      payloadsWithToolMedia: [{ text }],
      authProfileId,
      runParams: { authProfileStateMode: "read-only", onSuccessfulAuthProfile },
    });

    expect(resolved.action).toBe("complete");
    expect(onSuccessfulAuthProfile).toHaveBeenCalledExactlyOnceWith(authProfileId);
    if (resolved.action === "complete") {
      expect(resolved.result.meta.agentMeta).not.toHaveProperty("authProfileId");
    }
  });

  it.each([
    {
      reason: "auth" as const,
      expected: "Couldn't sign in to openai. Your saved login looks expired or no longer works.",
    },
    {
      reason: "auth_permanent" as const,
      expected: "openai isn't accepting your saved login.",
    },
  ])("surfaces provider recovery guidance for $reason terminal failures", async (testCase) => {
    const text = await resolveTerminalText({
      assistantProfileFailureReason: testCase.reason,
      retryState: { emptyResponseAttempts: 1 },
    });
    expect(text).toContain(testCase.expected);
    expect(text).toContain("openclaw configure");
  });

  it("does not replace timeout suppression with auth guidance", async () => {
    const assistant = emptyAssistant({ stopReason: "aborted" });
    const attempt = assistantAttempt(assistant, {
      terminal: { kind: "timeout", phase: "prompt", source: "external" },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    await expect(
      resolveTerminalText({
        attempt,
        attemptAssistant: assistant,
        assistantProfileFailureReason: "auth",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the side-effect warning ahead of auth guidance", async () => {
    const assistant = emptyAssistant({ stopReason: "error" });
    const attempt = assistantAttempt(assistant, {
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const text = await resolveTerminalText({
      attempt,
      attemptAssistant: assistant,
      assistantProfileFailureReason: "auth",
      replayState: { hadPotentialSideEffects: true, replayInvalid: true },
    });
    expect(text).toContain("some tool actions may have already been executed");
    expect(text).not.toContain("Couldn't sign in");
  });

  it("still reports an incomplete turn when auth failure bookkeeping rejects", async () => {
    const assistant = emptyAssistant({ stopReason: "length" });
    const attempt = assistantAttempt(assistant, {
      assistantTexts: [],
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const maybeMarkAuthProfileFailure = vi.fn(async () => {
      throw new Error("injected auth store write failure");
    });
    const resolved = await resolveTerminal({
      attempt,
      attemptAssistant: assistant,
      authProfileId: "openai:default",
      assistantProfileFailureReason: "unknown",
      maybeMarkAuthProfileFailure,
    });

    expectComplete(resolved);
    expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
    expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
    expect(resolved.result.meta.livenessState).toBe("abandoned");
    expect(maybeMarkAuthProfileFailure).toHaveBeenCalledWith({
      profileId: "openai:default",
      reason: "unknown",
      modelId: "gpt-5.6-luna",
    });
  });
});
