import { beforeEach, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import { resolveReplayInvalidFlag } from "./incomplete-turn-resolution.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { resolveEmbeddedRunTerminalTimeout } from "./terminal-timeout.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const timeoutTerminal = {
  kind: "timeout",
  phase: "tool_execution",
  source: "runtime",
  aborted: true,
} as const;
function child(expectsCompletionMessage: boolean) {
  return { runId: "child-1", childSessionKey: "agent:main:subagent:1", expectsCompletionMessage };
}

// mock-isolation: Observe bookkeeping calls without profile-store writes or auth-binding effects.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

async function resolveTerminal(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
  commentary?: string,
) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [
      ...(commentary ? [{ type: "text" as const, text: commentary }] : []),
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "test.txt" } },
    ],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: { ...timeoutTerminal },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    assistantTexts: commentary ? [commentary] : [],
    messagesSnapshot: [
      assistant,
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "Saved file contents" }],
        isError: false,
        timestamp: 0,
      },
    ],
    toolMetas: [{ toolName: "read", toolCallId: "read-1", isError: false, replaySafe: true }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...overrides,
  });
  const messages = [...attempt.messagesSnapshot];
  const input = makeTerminalInput({
    attempt,
    resolveReplayInvalid: (incompleteTurnText) =>
      resolveReplayInvalidFlag({ attempt, incompleteTurnText }),
  });
  input.prepared = await prepareAttempt({
    attempt,
    currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
    terminalState: input.terminalState,
  });
  const timeout = resolveEmbeddedRunTerminalTimeout({
    ...input,
    terminalPrepared: input.prepared,
  });
  const resolved = timeout
    ? { action: "complete" as const, result: timeout }
    : await resolveEmbeddedRunTerminal(input);
  expect(resolved.action).toBe("complete");
  if (resolved.action !== "complete") {
    throw new Error("Expected terminal completion without replay");
  }
  expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
  expect(attempt.messagesSnapshot).toEqual(messages);
  return { input, attempt, result: resolved.result };
}

function sentProgress(sourceProgress: boolean): Partial<EmbeddedRunAttemptResult> {
  const text = "I am checking.";
  return {
    didSendViaMessagingTool: true,
    didDeliverSourceReplyViaMessageTool: sourceProgress,
    messagingToolSentTexts: [text],
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "telegram",
        to: sourceProgress ? "source" : "another-conversation",
        text,
        ...(sourceProgress ? { sourceReplyFinal: false } : {}),
      },
    ],
    messagingToolSourceReplyPayloads: sourceProgress ? [{ text, sourceReplyFinal: false }] : [],
  };
}

beforeEach(() => vi.clearAllMocks());

it.each<[string, number, Partial<EmbeddedRunAttemptResult>?, string?]>([
  ["plain", 1],
  [
    "compaction failure",
    1,
    {
      terminal: {
        ...timeoutTerminal,
        failure: { source: "compaction", error: "synthetic bridge interrupted" },
      },
    },
  ],
  ["tool warning", 2, { lastToolError: { toolName: "read", error: "Earlier read failed" } }],
  [
    "quiet child",
    1,
    {
      acceptedSessionSpawns: [child(false)],
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    },
  ],
  ["source progress", 2, sentProgress(true)],
  ["other conversation", 1, sentProgress(false)],
  ["pre-tool commentary", 1, {}, "I'll read that."],
  ["scheduled job", 1, { successfulCronAdds: 1 }],
  ["tool media", 2, { toolMediaUrls: ["https://example.invalid/tool-output.png"] }],
])(
  "reports an unfinished tool timeout without success bookkeeping (%s)",
  async (name, payloads, overrides, commentary) => {
    const { input, attempt, result } = await resolveTerminal(
      { toolMediaUrls: [], ...overrides },
      commentary,
    );

    expect(result.payloads).toHaveLength(payloads);
    if (name === "tool media") {
      expect(result.payloads?.[0]?.mediaUrls).toEqual(attempt.toolMediaUrls);
    }
    expect(result.payloads?.at(-1)).toEqual({
      text: expect.stringContaining("Request timed out"),
      isError: true,
    });
    expect(result.meta).toMatchObject({
      modelFallbackStopReason: "agent_run_terminal_timeout",
      livenessState: "blocked",
      error: { kind: "incomplete_turn", fallbackSafe: false },
    });
    expect(result.meta.executionTrace?.attempts ?? []).not.toContainEqual(
      expect.objectContaining({ result: "success" }),
    );
    expect(input.setTerminalLifecycleMeta).toHaveBeenCalledWith(
      expect.objectContaining({ livenessState: "blocked" }),
    );
    expect(markEmbeddedRunAuthProfileSuccess).not.toHaveBeenCalled();
    expect(reportEmbeddedRunSuccessfulAuthBinding).not.toHaveBeenCalled();
    expect(result.messagingToolSentTargets).toEqual(attempt.messagingToolSentTargets);
  },
);

it.each(["delivered", "pending", "quiet child", "scheduled job", "ok", "timeout"] as const)(
  "preserves custody or yielded work (%s)",
  async (work) => {
    const custody = work === "delivered" || work === "pending";
    const { result } = await resolveTerminal(
      custody
        ? { sourceReplyDeliveryState: work }
        : {
            terminal: work === "timeout" ? { ...timeoutTerminal } : { kind: "ok" },
            yieldDetected: true,
            successfulCronAdds: work === "scheduled job" ? 1 : undefined,
            acceptedSessionSpawns: work === "scheduled job" ? [] : [child(work !== "quiet child")],
          },
    );
    expect(result.meta.error).toBeUndefined();
    if (!custody) {
      expect(result.meta.livenessState).toBe("paused");
    }
    expect(result.payloads ?? []).toEqual([]);
    expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
  },
);

it("keeps a successful final answer and successful bookkeeping", async () => {
  const text = "The file contains Saved file contents.";
  const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
  const { result } = await resolveTerminal({
    terminal: { kind: "ok" },
    assistantTexts: [text],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
  });
  expect(result.payloads).toEqual([{ text, replyToTag: false }]);
  expect(result.meta.error).toBeUndefined();
  expect(result.meta.livenessState).toBe("working");
  expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
  expect(reportEmbeddedRunSuccessfulAuthBinding).toHaveBeenCalledOnce();
});
