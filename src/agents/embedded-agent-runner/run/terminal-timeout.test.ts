import { beforeEach, describe, expect, it, vi } from "vitest";
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

// mock-isolation: Observe bookkeeping calls without profile-store writes or auth-binding effects.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

async function resolveTerminal(attempt: EmbeddedRunAttemptResult) {
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
  return { input, result: resolved.result };
}

function toolAttempt(overrides: Partial<EmbeddedRunAttemptResult> = {}, commentary?: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [
      ...(commentary ? [{ type: "text" as const, text: commentary }] : []),
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "test.txt" } },
    ],
  });
  return makeEmbeddedRunnerAttempt({
    terminal: { kind: "timeout", phase: "tool_execution", source: "runtime", aborted: true },
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
}

describe("tool timeout terminal bookkeeping", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    "plain",
    "compaction failure",
    "tool warning",
    "quiet child",
    "source progress",
    "other conversation",
    "pre-tool commentary",
    "scheduled job",
    "tool media",
  ])("reports an unfinished tool timeout without success bookkeeping (%s)", async (scenario) => {
    const toolWarning = scenario === "tool warning";
    const sourceProgress = scenario === "source progress";
    const sentMessage = sourceProgress || scenario === "other conversation";
    const attempt = toolAttempt(
      {
        lastToolError: toolWarning ? { toolName: "read", error: "Earlier read failed" } : undefined,
        successfulCronAdds: scenario === "scheduled job" ? 1 : undefined,
        toolMediaUrls: scenario === "tool media" ? ["https://example.invalid/tool-output.png"] : [],
        ...(scenario === "quiet child"
          ? {
              acceptedSessionSpawns: [
                {
                  runId: "quiet-child",
                  childSessionKey: "agent:main:subagent:quiet",
                  expectsCompletionMessage: false,
                },
              ],
              replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
            }
          : {}),
        ...(sentMessage
          ? {
              didSendViaMessagingTool: true,
              didDeliverSourceReplyViaMessageTool: sourceProgress,
              messagingToolSentTexts: ["I am checking."],
              messagingToolSentTargets: [
                {
                  tool: "message",
                  provider: "telegram",
                  to: sourceProgress ? "source" : "another-conversation",
                  text: "I am checking.",
                  ...(sourceProgress ? { sourceReplyFinal: false } : {}),
                },
              ],
              messagingToolSourceReplyPayloads: sourceProgress
                ? [{ text: "I am checking.", sourceReplyFinal: false }]
                : [],
            }
          : {}),
        terminal: {
          kind: "timeout",
          phase: "tool_execution",
          source: "runtime",
          aborted: true,
          ...(scenario === "compaction failure"
            ? { failure: { source: "compaction" as const, error: "synthetic bridge interrupted" } }
            : {}),
        },
      },
      scenario === "pre-tool commentary" ? "I'll read that." : undefined,
    );
    const messages = [...attempt.messagesSnapshot];
    const { input, result } = await resolveTerminal(attempt);

    expect(result.payloads).toHaveLength(
      toolWarning || sourceProgress || scenario === "tool media" ? 2 : 1,
    );
    if (scenario === "tool media") {
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
    expect(attempt.messagesSnapshot).toEqual(messages);
    expect(result.messagingToolSentTargets).toEqual(attempt.messagingToolSentTargets);
  });

  it.each(["delivered", "pending"] as const)(
    "preserves %s source-reply custody after a tool timeout",
    async (sourceReplyDeliveryState) => {
      const { result } = await resolveTerminal(toolAttempt({ sourceReplyDeliveryState }));
      expect(result.meta.error).toBeUndefined();
      expect(result.payloads ?? []).toEqual([]);
      expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    },
  );

  it.each(["quiet child", "scheduled job"])(
    "preserves a deliberate successful yield with %s work",
    async (work) => {
      const { result } = await resolveTerminal(
        toolAttempt({
          terminal: { kind: "ok" },
          yieldDetected: true,
          successfulCronAdds: work === "scheduled job" ? 1 : undefined,
          acceptedSessionSpawns:
            work === "quiet child"
              ? [
                  {
                    runId: "quiet-child",
                    childSessionKey: "agent:main:subagent:quiet",
                    expectsCompletionMessage: false,
                  },
                ]
              : [],
        }),
      );
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.livenessState).toBe("paused");
      expect(result.payloads ?? []).toEqual([]);
      expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    },
  );

  it.each(["ok", "timeout"] as const)(
    "preserves %s attempts with accepted continuations",
    async (kind) => {
      const { result } = await resolveTerminal(
        toolAttempt({
          ...(kind === "ok" ? { terminal: { kind } } : {}),
          yieldDetected: true,
          acceptedSessionSpawns: [
            {
              runId: "child-1",
              childSessionKey: "agent:main:subagent:1",
              expectsCompletionMessage: true,
            },
          ],
        }),
      );
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.livenessState).toBe("paused");
      expect(result.payloads ?? []).toEqual([]);
      expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    },
  );

  it("keeps a successful final answer and successful bookkeeping", async () => {
    const text = "The file contains Saved file contents.";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const { result } = await resolveTerminal(
      toolAttempt({
        terminal: { kind: "ok" },
        assistantTexts: [text],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
      }),
    );
    expect(result.payloads).toEqual([{ text, replyToTag: false }]);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
    expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    expect(reportEmbeddedRunSuccessfulAuthBinding).toHaveBeenCalledOnce();
  });
});
