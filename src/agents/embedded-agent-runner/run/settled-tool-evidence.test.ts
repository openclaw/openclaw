import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { makeEmbeddedRunnerAttempt as makeAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { isIncompleteTerminalAssistantTurn } from "./incomplete-turn-classification.js";
import {
  resolveSettledToolBatchEvidence,
  resolveSettledToolTerminalContinuation,
} from "./incomplete-turn-recovery.js";
import { resolveReplayInvalidFlag, resolveRunLivenessState } from "./incomplete-turn-resolution.js";
import {
  settledBatch,
  textAssistant,
  toolAssistant,
} from "./settled-turn-fixtures.test-support.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const CONTINUATION =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current transcript. Do not repeat completed tool calls or restart from scratch. Do not call tools in this step. Summarize the recorded results in plain text.";

function continuation(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveSettledToolTerminalContinuation>[0], "attempt">
  > = {},
) {
  return resolveSettledToolTerminalContinuation({
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelApi: "openai-responses",
    replyDeliveryState: "missing",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttempt(attemptOverrides),
    ...overrides,
  });
}

function makeSettledIdleWriteAttempt(options?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  stalePriorTurn?: boolean;
}) {
  const batch = settledBatch(["tool_1", "write"]);
  const abortedAssistant = textAssistant(undefined, { stopReason: "aborted" });
  return makeAttempt({
    terminal: options?.terminal ?? { kind: "timeout", phase: "prompt", source: "idle" },
    toolMetas: [{ toolName: "write", replaySafe: false }],
    itemLifecycle: batch.itemLifecycle,
    messagesSnapshot: [
      { role: "user", content: [{ type: "text", text: "old turn" }] },
      ...batch.messagesSnapshot,
      ...(options?.stalePriorTurn
        ? [{ role: "user", content: [{ type: "text", text: "current turn" }] }]
        : []),
      abortedAssistant,
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
    lastAssistant: abortedAssistant,
    currentAttemptAssistant: abortedAssistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
}

function failedToolInput(
  assistant = toolAssistant(["tool_1", "exec"]),
  resultToolName = "exec",
  lastErrorToolName = "exec",
) {
  return {
    assistantTexts: [],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    toolMetas: [{ toolName: resultToolName, isError: true }],
    messagesSnapshot: [
      assistant,
      { role: "toolResult", toolCallId: "tool_1", toolName: resultToolName, isError: true },
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    lastToolError: { toolName: lastErrorToolName, error: "post-processing error" },
  };
}

function emptyStop(overrides: Partial<EmbeddedRunAttemptResult> = {}) {
  const assistant = textAssistant();
  return {
    assistantTexts: [],
    toolMetas: [{ toolName: "write" }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...overrides,
  };
}

describe("runEmbeddedAgent incomplete-turn safety", () => {
  it("marks incomplete-turn retries as replay-invalid abandoned runs", () => {
    const attempt = makeAttempt({
      lastAssistant: textAssistant(undefined, { stopReason: "toolUse", model: "gpt-5.4" }),
    });
    const incompleteTurnText = "⚠️ Agent couldn't generate a response. Please try again.";

    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
        incompleteTurnText,
      }),
    ).toBe("abandoned");
  });

  it("flags tool-use stop reason as incomplete even when pre-tool text exists (#76477)", () => {
    for (const [stopReason, hasAssistantVisibleText, hasTerminalOutput, expected] of [
      ["toolUse", true, undefined, true],
      ["toolUse", false, undefined, true],
      ["end_turn", true, undefined, false],
      ["length", true, undefined, false],
      ["length", false, undefined, true],
      ["length", true, true, false],
      ["toolUse", true, true, true],
    ] as const) {
      expect(
        isIncompleteTerminalAssistantTurn({
          hasAssistantVisibleText,
          hasTerminalOutput,
          lastAssistant: { stopReason },
        }),
      ).toBe(expected);
    }
  });

  it.each([
    { source: "missing", terminal: "missing", continues: true },
    { source: "delivered", terminal: "missing", continues: true },
    { source: "missing", terminal: "delivered", continues: false },
    { source: "missing", terminal: "pending", continues: false },
  ] as const)(
    "uses prepared terminal $terminal rather than source $source for settled recovery",
    ({ source, terminal, continues }) => {
      const instruction = continuation(
        { ...makeSettledIdleWriteAttempt(), sourceReplyDeliveryState: source },
        { timedOut: true, replyDeliveryState: terminal },
      );

      expect(instruction?.instruction ?? null).toBe(continues ? CONTINUATION : null);
    },
  );

  it.each(["tool_1", "tool_stale"])(
    "matches terminal metadata to the current call (%s)",
    (toolCallId) => {
      const instruction = continuation({
        ...makeSettledIdleWriteAttempt(),
        toolMetas: [{ toolName: "write", toolCallId, replaySafe: false, terminate: true }],
      });
      expect(instruction?.instruction ?? null).toBe(toolCallId === "tool_1" ? null : CONTINUATION);
    },
  );

  it.each([false, true])(
    "uses the current occurrence of reused call IDs (terminal=%s)",
    (terminate) => {
      expect(
        continuation({
          ...makeSettledIdleWriteAttempt(),
          toolMetas: [
            { toolName: "write", toolCallId: "tool_1", terminate: true },
            { toolName: "write", toolCallId: "tool_1", ...(terminate ? { terminate } : {}) },
          ],
        })?.instruction ?? null,
      ).toBe(terminate ? null : CONTINUATION);
    },
  );

  it("continues when the current requested batch mixes terminal and nonterminal results", () => {
    const attempt = makeSettledIdleWriteAttempt();
    const batch = settledBatch(["tool_1", "write"], ["tool_2", "read"]);
    const instruction = continuation({
      ...attempt,
      ...batch,
      lastAssistant: attempt.lastAssistant,
      currentAttemptAssistant: attempt.currentAttemptAssistant,
      toolMetas: [
        { toolName: "write", toolCallId: "tool_1", terminate: true },
        { toolName: "read", toolCallId: "tool_2" },
      ],
      messagesSnapshot: [
        { role: "user", content: [{ type: "text", text: "current turn" }], timestamp: 0 },
        ...batch.messagesSnapshot,
        attempt.currentAttemptAssistant!,
      ],
    });

    expect(instruction?.instruction ?? null).toBe(CONTINUATION);
  });

  it.each([true, false])(
    "continues provider failure after settled tools only with finalization context (%s)",
    (hasContext) => {
      const attempt = makeSettledIdleWriteAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("provider failure") },
      });
      if (hasContext) {
        attempt.settledTurnFinalizationContext = {
          source: "openclaw-transcript",
          messages: attempt.messagesSnapshot,
        };
      }
      const instruction = continuation(attempt);

      expect(instruction?.instruction === CONTINUATION).toBe(hasContext);
    },
  );

  it.each([
    {
      label: "external abort",
      terminal: { kind: "timeout", phase: "prompt", source: "external" } as const,
      aborted: true,
      timedOut: true,
    },
    {
      label: "runtime timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "run budget timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "run_budget" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "compaction timeout",
      terminal: { kind: "timeout", phase: "compaction", source: "idle" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "tool execution timeout",
      terminal: { kind: "timeout", phase: "tool_execution", source: "idle" } as const,
      aborted: false,
      timedOut: true,
    },
    {
      label: "timeout observation",
      terminal: { kind: "timeout", phase: "tool_execution", source: "observation" } as const,
      aborted: false,
      timedOut: false,
    },
  ])("does not finalize settled tools after a $label", ({ terminal, aborted, timedOut }) => {
    const instruction = continuation(makeSettledIdleWriteAttempt({ terminal }), {
      aborted,
      timedOut,
    });

    expect(instruction).toBeNull();
  });

  it("does not use a settled prior-turn batch to authorize idle-timeout finalization", () => {
    const instruction = continuation(makeSettledIdleWriteAttempt({ stalePriorTurn: true }), {
      timedOut: true,
    });

    expect(instruction).toBeNull();
  });

  it.each([
    ["a matching failure summary", true, false],
    ["no remaining failure summary", false, false],
    ["a terminal-marked failed tool", true, true],
  ] as const)(
    "recognizes successful and failed current-batch tools with %s (#118274)",
    (_label, hasError, failedToolTerminate) => {
      const instruction = continuation({
        assistantTexts: [],
        ...settledBatch(["tool_ok", "read"], ["tool_failed", "exec", true]),
        toolMetas: [
          { toolName: "read" },
          {
            toolName: "exec",
            toolCallId: "tool_failed",
            isError: true,
            ...(failedToolTerminate ? { terminate: true } : {}),
          },
        ],
        lastToolError: hasError ? { toolName: "exec", error: "post-processing error" } : undefined,
      });

      expect(instruction?.instruction).toContain(CONTINUATION);
      expect(instruction?.instruction).toContain(
        "If a tool failed, say so; never claim completion or success.",
      );
    },
  );

  it.each([
    ["progress", false, false, "missing", true],
    ["final reply", true, false, "delivered", false],
    ["legacy source-confirmed send", undefined, true, "delivered", false],
    ["legacy coarse outbound send", undefined, false, "missing", true],
  ] as const)(
    "handles %s delivery evidence before settled finalization",
    (
      _label,
      sourceReplyFinal,
      didDeliverSourceReplyViaMessageTool,
      replyDeliveryState,
      expectedFinalization,
    ) => {
      const instruction = continuation(
        emptyStop({
          didSendViaMessagingTool: true,
          didDeliverSourceReplyViaMessageTool,
          messagingToolSentTexts: ["Writing note.txt…"],
          messagingToolSentTargets: [
            {
              tool: "message",
              provider: "telegram",
              to: "chat:123",
              text: "Writing note.txt…",
              sourceReplyFinal,
            },
          ],
        }),
        { allowEmptyStopContinuation: true, replyDeliveryState },
      );

      expect(instruction?.instruction ?? null).toBe(expectedFinalization ? CONTINUATION : null);
    },
  );

  it.each([
    ["an unrelated current-batch failure summary", "exec", "read"],
    ["a failed result with the wrong tool identity", "read", "exec"],
  ])("does not finalize %s (#118274)", (_label, resultToolName, lastErrorToolName) => {
    expect(continuation(failedToolInput(undefined, resultToolName, lastErrorToolName))).toBeNull();
  });

  it("does not settle same-name terminal calls from one failed result (#118274)", () => {
    const toolUseAssistant = toolAssistant(["tool_1", "exec"], ["tool_2", "exec"]);
    const instruction = continuation(failedToolInput(toolUseAssistant));

    expect(instruction).toBeNull();
  });

  it("keeps a successful terminating batch terminal with a stale earlier error (#132762)", () => {
    const failedAssistant = toolAssistant(["tool-failed", "exec"]);
    const toolUseAssistant = toolAssistant(["tool_1", "ask_user"]);
    const lastToolError = { toolName: "exec", error: "earlier failure" };
    const attempt = makeAttempt({
      assistantTexts: [],
      toolMetas: [
        { toolName: "exec", toolCallId: "tool-failed", isError: true },
        { toolName: "ask_user", toolCallId: "tool_1", isError: false, terminate: true },
      ],
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
      messagesSnapshot: [
        { role: "user", content: "Ask for the missing detail.", timestamp: 0 },
        failedAssistant,
        makeTextToolResult("tool-failed", "exec", "earlier failure", true, 1),
        toolUseAssistant,
        makeTextToolResult("tool_1", "ask_user", "Question delivered", false, 2),
      ],
      lastAssistant: toolUseAssistant,
      currentAttemptAssistant: toolUseAssistant,
      lastToolError,
    });
    const evidence = resolveSettledToolBatchEvidence(attempt);

    expect(evidence).toMatchObject({
      allToolsProvenSettled: true,
      hasStaleToolError: true,
      hasUnsettledToolError: false,
      intentionalTermination: true,
    });
    expect(continuation(attempt)).toBeNull();
    expect(attempt.lastToolError).toBe(lastToolError);
  });

  it.each<[string, Partial<EmbeddedRunAttemptResult>]>([
    ["async tool", { toolMetas: [{ toolName: "exec", isError: true, asyncStarted: true }] }],
    [
      "accepted child",
      {
        acceptedSessionSpawns: [
          { runId: "run-child", childSessionKey: "agent:main:subagent:child" },
        ],
      },
    ],
    ["pending client tool", { clientToolCalls: [{ name: "pending", params: {} }] }],
    ["yielded turn", { yieldDetected: true }],
    ["delivered approval", { didSendDeterministicApprovalPrompt: true }],
  ])("does not finalize a failed terminal tool with %s (#118274)", (_label, overrides) => {
    expect(continuation({ ...failedToolInput(), ...overrides })).toBeNull();
  });

  it.each([
    ["background trigger", false, 1, 1, 0, undefined, undefined],
    ["active tool", true, 1, 0, 1, undefined, undefined],
    ["partially completed batch", true, 2, 1, 0, undefined, undefined],
    ["async tool", true, 1, 1, 0, true, undefined],
    ["failed tool", true, 1, 1, 0, undefined, true],
  ] as const)(
    "does not continue an empty stop after %s activity",
    (
      _label,
      allowEmptyStopContinuation,
      startedCount,
      completedCount,
      activeCount,
      asyncStarted,
      isError,
    ) => {
      const instruction = continuation(
        emptyStop({
          toolMetas: [{ toolName: "write", asyncStarted, isError }],
          itemLifecycle: { startedCount, completedCount, activeCount },
        }),
        { allowEmptyStopContinuation },
      );

      expect(instruction).toBeNull();
    },
  );

  it("does not use a stale prior-turn empty stop to prove a settled continuation", () => {
    const instruction = continuation(emptyStop({ currentAttemptAssistant: undefined }), {
      allowEmptyStopContinuation: true,
    });

    expect(instruction).toBeNull();
  });
});
