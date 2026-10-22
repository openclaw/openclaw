import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  textAssistant,
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
    const onSuccessfulAuthProfile = vi.fn();
    const resolved = await resolveTerminal({
      assistant: textAssistant(text),
      attemptOverrides: { assistantTexts: [text] },
      payloadsWithToolMedia: [{ text }],
      authProfileId,
      runParams: { authProfileStateMode: "read-only", onSuccessfulAuthProfile },
    });

    expectComplete(resolved);
    expect(onSuccessfulAuthProfile).toHaveBeenCalledExactlyOnceWith(authProfileId);
    expect(resolved.result.meta.agentMeta).not.toHaveProperty("authProfileId");
  });

  it.each([
    ["auth", "Couldn't sign in to openai. Your saved login looks expired or no longer works."],
    ["auth_permanent", "openai isn't accepting your saved login."],
  ] as const)("surfaces provider recovery guidance for %s", async (reason, expected) => {
    const text = await resolveTerminalText({
      assistantProfileFailureReason: reason,
      retryState: { emptyResponseAttempts: 1 },
    });
    expect(text).toContain(expected);
    expect(text).toContain("openclaw configure");
  });

  it("does not replace timeout suppression with auth guidance", async () => {
    await expect(
      resolveTerminalText({
        assistant: emptyAssistant({ stopReason: "aborted" }),
        attemptOverrides: {
          terminal: { kind: "timeout", phase: "prompt", source: "external" },
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        },
        assistantProfileFailureReason: "auth",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the side-effect warning ahead of auth guidance", async () => {
    const text = await resolveTerminalText({
      assistant: emptyAssistant({ stopReason: "error" }),
      attemptOverrides: {
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      },
      assistantProfileFailureReason: "auth",
      replayState: { hadPotentialSideEffects: true, replayInvalid: true },
    });
    expect(text).toContain("some tool actions may have already been executed");
    expect(text).not.toContain("Couldn't sign in");
  });

  it("still reports an incomplete turn when auth failure bookkeeping rejects", async () => {
    const maybeMarkAuthProfileFailure = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("injected auth store write failure"));
    const resolved = await resolveTerminal({
      assistant: emptyAssistant({ stopReason: "length" }),
      attemptOverrides: {
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      },
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
