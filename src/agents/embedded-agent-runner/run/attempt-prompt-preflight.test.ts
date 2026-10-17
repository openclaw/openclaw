import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { testing } from "../../openai-transport-stream.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { log } from "../logger.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  estimateLlmBoundaryTokenPressure,
  estimateToolSchemaTokenPressure,
} from "./preemptive-compaction.js";

const attempt = {
  provider: "test-provider",
  modelId: "test-model",
  sessionFile: "/tmp/openclaw-attempt-preflight-test.jsonl",
  sessionId: "session-1",
  sessionKey: "agent:test:main",
  model: {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  } satisfies Model,
};

const request = {
  route: "compact_only" as const,
  estimatedPromptTokens: 150,
  promptBudgetBeforeReserve: 100,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 20,
};

function makeToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  } as AgentMessage;
}

function createSessionManagerWithMessage(message: AgentMessage): SessionManager {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
  return sessionManager;
}

function preflight(
  overrides: Partial<Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0]>,
) {
  return prepareEmbeddedAttemptPromptPreflight({
    attempt,
    compactionReplayEnabled: true,
    contextEnginePromptAuthority: "assembled",
    contextTokenBudget: 1_000,
    hookMessagesForCurrentPrompt: [],
    includeBoundaryTimestamp: false,
    promptForPrecheck: "follow-up",
    reserveTokens: 100,
    sessionMessageCount: 1,
    systemPrompt: "",
    toolResultMaxChars: 1_000,
    state: {
      contextBudgetStatus: undefined,
      preflightRecovery: undefined,
      promptError: null,
      promptErrorSource: null,
      skipPromptSubmission: false,
    },
    ...overrides,
  });
}

function midTurn(
  overrides: Partial<Parameters<typeof handleEmbeddedAttemptMidTurnPrecheck>[0]> = {},
) {
  return handleEmbeddedAttemptMidTurnPrecheck({
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    attempt,
    request,
    sessionAgentId: "test",
    sessionManager: overrides.sessionManager ?? SessionManager.inMemory(),
    prePromptMessageCount: 4,
    replaceSessionMessages: vi.fn(),
    ...overrides,
  });
}

function checkpoint(discarded: boolean, windowText?: string) {
  const owner = makeAgentAssistantMessage({
    content: discarded ? [] : [{ type: "text", text: "covered" }],
    model: attempt.model.id,
  });
  const item = {
    type: "compaction" as const,
    id: discarded ? "cmp_discarded" : "cmp_test",
    encrypted_content: discarded ? "discarded opaque" : "opaque",
  };
  captureOpenAIResponsesCompaction(
    owner,
    item,
    "retained-users",
    attempt.model,
    testing.buildOpenAIResponsesReasoningReplayMetadata(attempt.model, attempt),
    windowText === undefined
      ? undefined
      : [
          { type: "message", role: "user", content: [{ type: "input_text", text: windowText }] },
          item,
        ],
  );
  return owner;
}

describe("attempt prompt preflight", () => {
  it.each([
    "oversized",
    "unwindowed-tools",
    "missing-window",
    "discarded-invalid",
    "fitting-with-discarded-invalid",
    "fitting-with-tool-output-schema",
  ] as const)("handles a %s provider checkpoint", async (variant) => {
    const discarded = variant === "discarded-invalid";
    const fitting = variant.startsWith("fitting-");
    const unwindowed = variant === "unwindowed-tools";
    const toolWithOutputSchema = {
      name: "lookup",
      description: "Look up a record.",
      parameters: { type: "object" },
      outputSchema: {
        type: "string",
        description: "result documentation ".repeat(4_000),
      },
    };
    const owner = checkpoint(
      false,
      variant === "missing-window" || discarded
        ? undefined
        : fitting
          ? "small retained window"
          : "retained content ".repeat(8_000),
    );
    const discardedInvalid = checkpoint(true);
    let unwindowedMessages: AgentMessage[] | undefined;
    if (discarded) {
      unwindowedMessages = [owner];
    } else if (unwindowed) {
      unwindowedMessages = [
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        }),
        makeToolResultMessage("raw tool history ".repeat(40_000)),
      ];
    } else if (fitting) {
      unwindowedMessages = [
        ...(variant === "fitting-with-discarded-invalid" ? [owner, discardedInvalid] : []),
        { role: "user", content: "raw history ".repeat(40_000), timestamp: 1 },
      ];
    }
    const result = await preflight({
      contextEnginePromptAuthority:
        unwindowed || discarded || fitting ? "preassembly_may_overflow" : "assembled",
      unwindowedContextEngineMessagesForPrecheck: unwindowedMessages,
      hookMessagesForCurrentPrompt: discarded ? [] : [owner],
      toolSchemaTokens:
        variant === "fitting-with-tool-output-schema"
          ? estimateToolSchemaTokenPressure([toolWithOutputSchema])
          : undefined,
    });
    if (discarded || fitting) {
      expect(result.skipPromptSubmission).toBe(false);
      expect(result.promptError).toBeNull();
      expect(result.preflightRecovery).toBeUndefined();
      if (fitting) {
        expect(result.contextBudgetStatus?.estimatedPromptTokens).toBeGreaterThan(20_000);
      }
      return;
    }
    expect(result.skipPromptSubmission).toBe(true);
    expect(result.promptErrorSource).toBe("precheck");
    if (variant !== "missing-window") {
      expect(result.preflightRecovery?.route).toBe("compact_only");
      expect(result.contextBudgetStatus?.estimatedPromptTokens).toBeGreaterThan(20_000);
      if (unwindowed) {
        expect(result.preflightRecovery?.estimatedPromptTokens).toBe(
          estimateLlmBoundaryTokenPressure({
            messages: [owner],
            prompt: "follow-up",
            replay: { model: attempt.model, sessionId: attempt.sessionId, enabled: true },
          }),
        );
        expect(result.contextBudgetStatus?.toolResultReducibleChars).toBeGreaterThan(0);
        expect(result.contextBudgetStatus?.route).not.toBe("compact_only");
      }
    } else {
      expect(result.preflightRecovery).toBeUndefined();
      expect(String(result.promptError)).toContain("Run /compact");
    }
  });

  it("routes a mid-turn compaction request with its measured budget", async () => {
    const outcome = await midTurn();

    expect(outcome).toEqual({
      preflightRecovery: {
        route: "compact_only",
        source: "mid-turn",
        estimatedPromptTokens: 150,
        promptBudgetBeforeReserve: 100,
        overflowTokens: 50,
      },
      promptError: expect.objectContaining({ message: PREEMPTIVE_OVERFLOW_ERROR_TEXT }),
    });
  });

  it.each([
    { truncatedCount: 0, text: "already capped tool output", contextTokenBudget: undefined },
    { truncatedCount: 1, text: "large tool output ".repeat(5_000), contextTokenBudget: 100 },
  ])(
    "handles $truncatedCount persisted truncations without a prompt error",
    async ({ truncatedCount, text, contextTokenBudget }) => {
      const toolResult = makeToolResultMessage(text);
      const sessionManager = createSessionManagerWithMessage(toolResult);
      const messagesBefore = sessionManager.buildSessionContext().messages;
      const replaceSessionMessages = vi.fn();
      const outcome = await midTurn({
        attempt: { ...attempt, contextTokenBudget },
        request: { ...request, route: "truncate_tool_results_only" },
        sessionManager,
        replaceSessionMessages,
      });

      expect(outcome.preflightRecovery).toMatchObject({
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount,
      });
      expect(outcome.promptError).toBeUndefined();
      if (truncatedCount) {
        expect(replaceSessionMessages).toHaveBeenCalledWith(
          sessionManager.buildSessionContext().messages,
        );
      } else {
        expect(replaceSessionMessages).not.toHaveBeenCalled();
        expect(sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
      }
    },
  );

  it("keeps the compaction fallback when persisted truncation cannot inspect history", async () => {
    const outcome = await midTurn({
      request: { ...request, route: "truncate_tool_results_only" },
    });

    expect(outcome.preflightRecovery.route).toBe("compact_only");
    expect(outcome.promptError?.message).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
  });

  it("warns and keeps client recovery when V2 pending input exceeds the hard budget", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const result = await preflight({
        providerCompactionAtRequestBoundary: true,
        contextTokenBudget: 100,
        pendingInputTokens: 101,
        promptForPrecheck: "oversized input",
        reserveTokens: 20,
        sessionMessageCount: 0,
      });
      expect(result.preflightRecovery).toEqual({ route: "compact_only" });
      expect(result.skipPromptSubmission).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to client compaction: pending input exceeds"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not persist heuristic pre-prompt tool-result truncation", async () => {
    const toolResult = makeToolResultMessage("alpha beta gamma delta epsilon ".repeat(2_200));
    const messages = [toolResult];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const contextTokenBudget = estimatedPromptTokens - 200 + reserveTokens;
    const sessionManager = createSessionManagerWithMessage(toolResult);

    const result = await preflight({
      contextTokenBudget,
      hookMessagesForCurrentPrompt: messages,
      includeBoundaryTimestamp: true,
      promptForPrecheck: "hello",
      reserveTokens,
      sessionMessageCount: messages.length,
      systemPrompt: "sys",
    });

    expect(result).toMatchObject({
      skipPromptSubmission: false,
      promptError: null,
      promptErrorSource: null,
      preflightRecovery: undefined,
    });
    expect(sessionManager.buildSessionContext().messages).toEqual([toolResult]);
  });
});
