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
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current transcript. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

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
  const toolUseAssistant = toolAssistant(["tool_1", "write"]);
  const abortedAssistant = textAssistant(undefined, { stopReason: "aborted" });
  return makeAttempt({
    terminal: options?.terminal ?? { kind: "timeout", phase: "prompt", source: "idle" },
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
    const attempt = makeAttempt({
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

  it("tells the finalizer that tools are unavailable", () => {
    // The settled-turn finalization pass runs with disableTools: true. If the instruction
    // does not say so, the model reaches for a tool, the denied call registers as capability
    // activity, and projectSettledTurnFinalizationAttemptResult throws away the whole result
    // -- including a perfectly good answer produced in the same completion.
    const instruction = continuation(makeSettledIdleWriteAttempt(), {
      timedOut: true,
    });

    expect(instruction?.instruction).toContain("Tools are unavailable in this step");
    expect(instruction?.instruction).toContain("do not attempt any tool call");
    expect(instruction?.disableTools).toBe(true);
  });

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

  it.each([
    {
      label: "provider failure with finalization context",
      hasContext: true,
      expectedContinuation: true,
    },
    {
      label: "provider failure without finalization context",
      hasContext: false,
      expectedContinuation: false,
    },
  ])(
    "$label after settled tools returns continuation=$expectedContinuation",
    ({ hasContext, expectedContinuation }) => {
      const attempt = makeSettledIdleWriteAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("provider failure") },
      });
      const instruction = continuation(
        hasContext
          ? {
              ...attempt,
              settledTurnFinalizationContext: {
                source: "openclaw-transcript",
                messages: attempt.messagesSnapshot,
              },
            }
          : attempt,
      );

      expect(instruction?.instruction === CONTINUATION).toBe(expectedContinuation);
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
    {
      label: "a matching failure summary",
      lastToolError: { toolName: "exec", error: "post-processing error" },
    },
    { label: "no remaining failure summary", lastToolError: undefined },
    {
      label: "a terminal-marked failed tool",
      lastToolError: { toolName: "exec", error: "post-processing error" },
      failedToolTerminate: true,
    },
  ])(
    "recognizes successful and failed current-batch tools with $label (#118274)",
    ({ lastToolError, failedToolTerminate }) => {
      const toolUseAssistant = textAssistant(undefined, {
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool_ok", name: "read", arguments: {} },
          { type: "toolCall", id: "tool_failed", name: "exec", arguments: {} },
        ],
      });
      const instruction = continuation({
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
      const emptyStopAssistant = textAssistant();
      const instruction = continuation(
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
        { allowEmptyStopContinuation: true, replyDeliveryState },
      );

      expect(instruction?.instruction ?? null).toBe(expectedFinalization ? CONTINUATION : null);
    },
  );

  it.each([
    {
      label: "an unrelated current-batch failure summary",
      resultToolName: "exec",
      lastErrorToolName: "read",
    },
    {
      label: "a failed result with the wrong tool identity",
      resultToolName: "read",
      lastErrorToolName: "exec",
    },
  ])("does not finalize $label (#118274)", ({ resultToolName, lastErrorToolName }) => {
    const toolUseAssistant = textAssistant(undefined, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const instruction = continuation({
      assistantTexts: [],
      toolMetas: [{ toolName: resultToolName, isError: true }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        toolUseAssistant,
        {
          role: "toolResult",
          toolCallId: "tool_1",
          toolName: resultToolName,
          isError: true,
        },
      ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"],
      lastAssistant: toolUseAssistant,
      currentAttemptAssistant: toolUseAssistant,
      lastToolError: { toolName: lastErrorToolName, error: "post-processing error" },
    });

    expect(instruction).toBeNull();
  });

  it("does not settle same-name terminal calls from one failed result (#118274)", () => {
    const toolUseAssistant = textAssistant(undefined, {
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "tool_1", name: "exec", arguments: {} },
        { type: "toolCall", id: "tool_2", name: "exec", arguments: {} },
      ],
    });
    const instruction = continuation({
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
    });

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

  it.each([
    {
      label: "an async tool is still running",
      attemptOverrides: { toolMetas: [{ toolName: "exec", isError: true, asyncStarted: true }] },
    },
    {
      label: "an accepted child session owns the response",
      attemptOverrides: {
        acceptedSessionSpawns: [
          { runId: "run-child", childSessionKey: "agent:main:subagent:child" },
        ],
      },
    },
    {
      label: "a client tool remains pending",
      attemptOverrides: { clientToolCalls: [{ name: "pending", params: {} }] },
    },
    {
      label: "the turn yielded",
      attemptOverrides: { yieldDetected: true },
    },
    {
      label: "an approval prompt was already delivered",
      attemptOverrides: { didSendDeterministicApprovalPrompt: true },
    },
  ])("does not finalize a failed terminal tool when $label (#118274)", ({ attemptOverrides }) => {
    const toolUseAssistant = textAssistant(undefined, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool_1", name: "exec", arguments: {} }],
    });
    const instruction = continuation({
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
    });

    expect(instruction).toBeNull();
  });

  it.each([
    { label: "background trigger", allowEmptyStopContinuation: false },
    {
      label: "active tool",
      allowEmptyStopContinuation: true,
      completedCount: 0,
      activeCount: 1,
    },
    {
      label: "partially completed tool batch",
      allowEmptyStopContinuation: true,
      startedCount: 2,
      completedCount: 1,
    },
    { label: "async tool", allowEmptyStopContinuation: true, asyncStarted: true },
    { label: "failed tool", allowEmptyStopContinuation: true, isError: true },
  ])(
    "does not continue an empty stop after $label activity",
    ({
      allowEmptyStopContinuation,
      startedCount = 1,
      completedCount = 1,
      activeCount = 0,
      asyncStarted,
      isError,
    }) => {
      const emptyStopAssistant = textAssistant();
      const instruction = continuation(
        {
          assistantTexts: [],
          toolMetas: [{ toolName: "write", asyncStarted, isError }],
          itemLifecycle: { startedCount, completedCount, activeCount },
          lastAssistant: emptyStopAssistant,
          currentAttemptAssistant: emptyStopAssistant,
        },
        { allowEmptyStopContinuation },
      );

      expect(instruction).toBeNull();
    },
  );

  it("does not use a stale prior-turn empty stop to prove a settled continuation", () => {
    const staleEmptyStopAssistant = textAssistant();
    const instruction = continuation(
      {
        assistantTexts: [],
        toolMetas: [{ toolName: "write" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: staleEmptyStopAssistant,
        currentAttemptAssistant: undefined,
      },
      { allowEmptyStopContinuation: true },
    );

    expect(instruction).toBeNull();
  });
});
