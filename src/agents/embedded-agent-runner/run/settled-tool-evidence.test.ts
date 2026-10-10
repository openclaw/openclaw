// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { isIncompleteTerminalAssistantTurn } from "./incomplete-turn-classification.js";
import {
  resolveSettledToolBatchEvidence,
  resolveSettledToolTerminalContinuationInstruction,
} from "./incomplete-turn-recovery.js";
import { resolveReplayInvalidFlag, resolveRunLivenessState } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Partial<LastAssistant> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt(overrides);
}

function makeSettledContinuationParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelApi: "openai-responses",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

function makeSettledIdleWriteAttempt(options?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  stalePriorTurn?: boolean;
}) {
  const toolUseAssistant = makeLastAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: {} }],
  });
  const abortedAssistant = makeLastAssistant({ stopReason: "aborted", content: [] });
  return makeAttemptResult({
    terminal: options?.terminal ?? { kind: "timeout", phase: "prompt", source: "idle" },
    assistantTexts: [],
    toolMetas: [{ toolName: "write", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    messagesSnapshot: [
      { role: "user", content: [{ type: "text", text: "old turn" }] },
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
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

describe("runEmbeddedAgent incomplete-turn safety", () => {
  it("marks incomplete-turn retries as replay-invalid abandoned runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        stopReason: "toolUse",
        provider: "openai",
        model: "gpt-5.4",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
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
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: false,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "end_turn" },
      }),
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "length" },
      }),
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: false,
        lastAssistant: { stopReason: "length" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        hasTerminalOutput: true,
        lastAssistant: { stopReason: "length" },
      }),
    ).toBe(false);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        hasTerminalOutput: true,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "nonterminal",
      currentMeta: { toolName: "write", toolCallId: "tool_1" },
      expected: SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
    },
  ])(
    "uses the $label current occurrence when a provider reuses a tool-call id",
    ({ currentMeta, expected }) => {
      const attempt = makeSettledIdleWriteAttempt();
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams({
          ...attempt,
          toolMetas: [{ toolName: "write", toolCallId: "tool_1", terminate: true }, currentMeta],
        }),
      );

      expect(instruction).toBe(expected);
    },
  );

  it("continues when the current requested batch mixes terminal and nonterminal results", () => {
    const attempt = makeSettledIdleWriteAttempt();
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_1", name: "write", arguments: {} },
        { type: "toolCall", id: "tool_2", name: "read", arguments: {} },
      ],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams({
        ...attempt,
        toolMetas: [
          { toolName: "write", toolCallId: "tool_1", terminate: true },
          { toolName: "read", toolCallId: "tool_2" },
        ],
        itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
        messagesSnapshot: [
          { role: "user", content: [{ type: "text", text: "current turn" }] },
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
          { role: "toolResult", toolCallId: "tool_2", toolName: "read", isError: false },
          attempt.currentAttemptAssistant!,
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
      }),
    );

    expect(instruction).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
  });

  it.each([
    {
      label: "provider failure with finalization context",
      hasContext: true,
      expectedContinuation: true,
    },
  ])(
    "$label after settled tools returns continuation=$expectedContinuation",
    ({ hasContext, expectedContinuation }) => {
      const attempt = makeSettledIdleWriteAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("provider failure") },
      });
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams(
          hasContext
            ? {
                ...attempt,
                settledTurnFinalizationContext: {
                  source: "openclaw-transcript",
                  messages: attempt.messagesSnapshot,
                },
              }
            : attempt,
        ),
      );

      expect(instruction === SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION).toBe(
        expectedContinuation,
      );
    },
  );

  it("does not use a settled prior-turn batch to authorize idle-timeout finalization", () => {
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(makeSettledIdleWriteAttempt({ stalePriorTurn: true }), {
        timedOut: true,
      }),
    );

    expect(instruction).toBeNull();
  });

  it.each([
    {
      label: "a terminal-marked failed tool",
      lastToolError: { toolName: "exec", error: "post-processing error" },
      failedToolTerminate: true,
    },
  ])(
    "recognizes successful and failed current-batch tools with $label (#118274)",
    ({ lastToolError, failedToolTerminate }) => {
      const toolUseAssistant = makeLastAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool_ok", name: "read", arguments: {} },
          { type: "toolCall", id: "tool_failed", name: "exec", arguments: {} },
        ],
      });
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams({
          assistantTexts: [],
          toolMetas: [
            { toolName: "read" },
            {
              toolName: "exec",
              toolCallId: "tool_failed",
              isError: true,
              ...(failedToolTerminate ? { terminate: true } : {}),
            },
          ],
          itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          messagesSnapshot: [
            toolUseAssistant,
            { role: "toolResult", toolCallId: "tool_ok", toolName: "read", isError: false },
            { role: "toolResult", toolCallId: "tool_failed", toolName: "exec", isError: true },
          ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
          lastAssistant: toolUseAssistant,
          currentAttemptAssistant: toolUseAssistant,
          lastToolError,
        }),
      );

      expect(instruction).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
      expect(instruction).toContain("If a tool failed, say so; never claim completion or success.");
    },
  );

  it.each([
    {
      label: "progress",
      sourceReplyFinal: false,
      didDeliverSourceReplyViaMessageTool: false,
      expectedFinalization: true,
    },
    {
      label: "legacy source-confirmed send",
      sourceReplyFinal: undefined,
      didDeliverSourceReplyViaMessageTool: true,
      expectedFinalization: false,
    },
  ])(
    "handles $label delivery evidence before settled finalization",
    ({ sourceReplyFinal, didDeliverSourceReplyViaMessageTool, expectedFinalization }) => {
      const emptyStopAssistant = makeLastAssistant();
      const instruction = resolveSettledToolTerminalContinuationInstruction(
        makeSettledContinuationParams(
          {
            assistantTexts: [],
            toolMetas: [{ toolName: "write" }],
            itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
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
            lastAssistant: emptyStopAssistant,
            currentAttemptAssistant: emptyStopAssistant,
          },
          { allowEmptyStopContinuation: true },
        ),
      );

      expect(instruction).toBe(
        expectedFinalization ? SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION : null,
      );
    },
  );

  it("keeps a successful terminating batch terminal with a stale earlier error (#132762)", () => {
    const failedAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-failed", name: "exec", arguments: {} }],
    });
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "ask_user", arguments: {} }],
    });
    const lastToolError = { toolName: "exec", error: "earlier failure" };
    const attempt = makeAttemptResult({
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
    expect(
      resolveSettledToolTerminalContinuationInstruction(makeSettledContinuationParams(attempt)),
    ).toBeNull();
    expect(attempt.lastToolError).toBe(lastToolError);
  });

  it.each([
    {
      label: "an accepted child session owns the response",
      attemptOverrides: {
        acceptedSessionSpawns: [
          { runId: "run-child", childSessionKey: "agent:main:subagent:child" },
        ],
      },
    },
  ])("does not finalize a failed terminal tool when $label (#118274)", ({ attemptOverrides }) => {
    const toolUseAssistant = makeLastAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec", isError: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          toolUseAssistant,
          { role: "toolResult", toolCallId: "tool_1", toolName: "exec", isError: true },
        ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
        lastToolError: { toolName: "exec", error: "post-processing error" },
        ...attemptOverrides,
      }),
    );

    expect(instruction).toBeNull();
  });

  it("does not use a stale prior-turn empty stop to prove a settled continuation", () => {
    const staleEmptyStopAssistant = makeLastAssistant();
    const instruction = resolveSettledToolTerminalContinuationInstruction(
      makeSettledContinuationParams(
        {
          assistantTexts: [],
          toolMetas: [{ toolName: "write" }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          lastAssistant: staleEmptyStopAssistant,
          currentAttemptAssistant: undefined,
        },
        { allowEmptyStopContinuation: true },
      ),
    );

    expect(instruction).toBeNull();
  });
});
