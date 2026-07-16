import { describe, expect, it } from "vitest";
import { resolveToolUseTerminalContinuationInstruction } from "./incomplete-turn.js";

function makeAttempt(
  overrides: Partial<
    Parameters<typeof resolveToolUseTerminalContinuationInstruction>[0]["attempt"]
  > = {},
): Parameters<typeof resolveToolUseTerminalContinuationInstruction>[0]["attempt"] {
  return {
    assistantTexts: [],
    clientToolCalls: undefined,
    currentAttemptAssistant: undefined,
    yieldDetected: undefined,
    didSendDeterministicApprovalPrompt: false,
    heartbeatToolResponse: undefined,
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    toolTrustedLocalMedia: false,
    hasToolMediaBlockReply: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSourceReplyPayloads: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    lastToolError: undefined,
    lastAssistant: { stopReason: "toolUse" } as never,
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    toolMetas: [{ toolName: "test_tool", replaySafe: false }],
    ...overrides,
  };
}

function makeParams(
  overrides: Partial<Parameters<typeof resolveToolUseTerminalContinuationInstruction>[0]> = {},
): Parameters<typeof resolveToolUseTerminalContinuationInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelApi: "openai-responses",
    aborted: false,
    timedOut: false,
    attempt: makeAttempt(),
    ...overrides,
  };
}

describe("resolveToolUseTerminalContinuationInstruction", () => {
  it("returns instruction for toolUse terminal with toolMetas and no visible text", () => {
    const result = resolveToolUseTerminalContinuationInstruction(makeParams());
    expect(result).toBeTypeOf("string");
    expect(result).toContain("tool results are already present");
  });

  it("returns null when aborted", () => {
    expect(resolveToolUseTerminalContinuationInstruction(makeParams({ aborted: true }))).toBeNull();
  });

  it("returns null when timedOut", () => {
    expect(
      resolveToolUseTerminalContinuationInstruction(makeParams({ timedOut: true })),
    ).toBeNull();
  });

  it("returns null for non-toolUse stopReason", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({
        attempt: makeAttempt({
          lastAssistant: { stopReason: "stop" } as never,
        }),
      }),
    );
    expect(result).toBeNull();
  });

  it("returns null when toolMetas is empty", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({ attempt: makeAttempt({ toolMetas: [] }) }),
    );
    expect(result).toBeNull();
  });

  it("returns null when there is visible assistant text", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({ attempt: makeAttempt({ assistantTexts: ["Here is the answer"] }) }),
    );
    expect(result).toBeNull();
  });

  it("returns null when clientToolCalls is set", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({
        attempt: makeAttempt({ clientToolCalls: [{ name: "test", params: {} }] as never }),
      }),
    );
    expect(result).toBeNull();
  });

  it("returns null when lastToolError is set", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({ attempt: makeAttempt({ lastToolError: "some error" as never }) }),
    );
    expect(result).toBeNull();
  });

  it("returns null when modelApi is not in RETRY_GUARD_MODEL_APIS", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({
        modelApi: "some-unknown-api",
        provider: "custom",
        executionContract: undefined,
      }),
    );
    expect(result).toBeNull();
  });

  it("returns null when session spawn was accepted", () => {
    const result = resolveToolUseTerminalContinuationInstruction(
      makeParams({
        attempt: makeAttempt({
          acceptedSessionSpawns: [{ runId: "r1", childSessionKey: "s1" }] as never,
        }),
      }),
    );
    expect(result).toBeNull();
  });
});
