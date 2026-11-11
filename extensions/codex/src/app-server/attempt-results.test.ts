import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";

function createResult(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  } as EmbeddedRunAttemptResult;
}

const blockedReason = (overrides: Partial<EmbeddedRunAttemptResult> = {}) =>
  resolveCodexAppServerReplayBlockedReason(createResult(overrides));

describe("Codex app-server attempt results", () => {
  it("formats terminal assistant text", () => {
    expect(
      collectTerminalAssistantText(createResult({ assistantTexts: [" first ", "second"] })),
    ).toBe("first \n\nsecond");
  });

  it("does not invent a timeout outcome without a deadline failure", () => {
    expect(buildCodexAppServerPromptTimeoutOutcome(undefined)).toBeUndefined();
  });

  it.each([
    {
      kind: "execution" as const,
      message:
        "Codex reached the configured execution time limit. Some work may already have been performed; verify the current state before continuing.",
    },
    {
      kind: "settlement" as const,
      message:
        "Codex finished its turn, but OpenClaw could not finish processing the result. Some work may already have been performed; verify the current state before continuing.",
    },
  ])("reports the $kind owner and prevents automatic replay", ({ kind, message }) => {
    expect(
      buildCodexAppServerPromptTimeoutOutcome({ kind, elapsedMs: 120_000, timeoutMs: 120_000 }),
    ).toEqual({
      message,
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("classifies replay blocked reasons", () => {
    expect(blockedReason()).toBeUndefined();
    expect(
      blockedReason({ replayMetadata: { hadPotentialSideEffects: true, replaySafe: false } }),
    ).toBe("potential_side_effect");
    expect(blockedReason({ assistantTexts: ["visible"] })).toBe("assistant_output");
    expect(blockedReason({ toolMetas: [{ name: "exec" }] as never })).toBe("tool_activity");
    expect(
      blockedReason({ itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } }),
    ).toBe("active_item");
  });

  it("recognizes invalid image payload errors without matching unsupported image input", () => {
    expect(isInvalidCodexImagePayloadError("invalid_image_url")).toBe(true);
    expect(isInvalidCodexImagePayloadError("malformed-base64 image payload")).toBe(true);
    expect(isInvalidCodexImagePayloadError("unsupported image input")).toBe(false);
  });
});
