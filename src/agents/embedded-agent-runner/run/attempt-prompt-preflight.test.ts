import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { testing } from "../../openai-transport-stream.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
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
  model: makeProviderModelFixture({
    id: "gpt-5.6-luna",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 8_192,
  }),
};

const request = {
  route: "compact_only" as const,
  estimatedPromptTokens: 150,
  promptBudgetBeforeReserve: 100,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 20,
};

const makeToolResult = (text: string) => makeTextToolResult("call-1", "read", text, false, 1);

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
    let unwindowedMessages: AgentMessage[] | undefined;
    if (discarded) {
      unwindowedMessages = [owner];
    } else if (unwindowed) {
      unwindowedMessages = [
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        }),
        makeToolResult("raw tool history ".repeat(40_000)),
      ];
    } else if (fitting) {
      unwindowedMessages = [
        ...(variant === "fitting-with-discarded-invalid" ? [owner, checkpoint(true)] : []),
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
      expect(result).toMatchObject({
        skipPromptSubmission: false,
        promptError: null,
        preflightRecovery: undefined,
      });
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

  it.each([
    ["compaction", "compact_only", "", undefined, undefined],
    ["fallback", "truncate_tool_results_only", "", undefined, undefined],
    ["capped", "truncate_tool_results_only", "already capped tool output", undefined, 0],
    ["truncation", "truncate_tool_results_only", "large tool output ".repeat(5_000), 100, 1],
  ] as const)(
    "handles mid-turn %s",
    async (_name, route, text, contextTokenBudget, truncatedCount) => {
      const sessionManager = SessionManager.inMemory();
      if (text) {
        sessionManager.appendMessage(makeToolResult(text));
      }
      const messagesBefore = sessionManager.buildSessionContext().messages;
      const replaceMessages = vi.fn();
      const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        attempt: { ...attempt, contextTokenBudget },
        request: { ...request, route },
        sessionAgentId: "test",
        sessionManager,
        prePromptMessageCount: 4,
        replaceSessionMessages: replaceMessages,
      });
      if (truncatedCount === undefined) {
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
        return;
      }
      expect(outcome.preflightRecovery).toMatchObject({
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount,
      });
      expect(outcome.promptError).toBeUndefined();
      if (truncatedCount) {
        expect(replaceMessages).toHaveBeenCalledWith(sessionManager.buildSessionContext().messages);
      } else {
        expect(replaceMessages).not.toHaveBeenCalled();
        expect(sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
      }
    },
  );

  it("keeps client recovery when V2 pending input exceeds the hard budget", async () => {
    const result = await preflight({
      providerCompactionAtRequestBoundary: true,
      contextTokenBudget: 100,
      pendingInputTokens: 101,
    });
    expect(result.preflightRecovery).toEqual({ route: "compact_only" });
    expect(result.skipPromptSubmission).toBe(true);
  });

  it("admits heuristic tool-result pressure without recovery or mutating history", async () => {
    const toolResult = makeToolResult("alpha beta gamma delta epsilon ".repeat(2_200));
    const messages = [toolResult];
    const messagesBefore = structuredClone(messages);
    const reserveTokens = 2_000;
    const prompt = { systemPrompt: "sys", prompt: "hello" };
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      ...prompt,
    });

    const result = await preflight({
      contextTokenBudget: estimatedPromptTokens - 200 + reserveTokens,
      hookMessagesForCurrentPrompt: messages,
      includeBoundaryTimestamp: true,
      promptForPrecheck: prompt.prompt,
      reserveTokens,
      sessionMessageCount: 1,
      systemPrompt: prompt.systemPrompt,
    });

    expect(result).toMatchObject({
      skipPromptSubmission: false,
      promptError: null,
      promptErrorSource: null,
      preflightRecovery: undefined,
    });
    expect(messages).toEqual(messagesBefore);
  });
});
