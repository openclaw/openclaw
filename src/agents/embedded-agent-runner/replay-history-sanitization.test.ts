import { describe, expect, it, vi } from "vitest";
import { annotateInterSessionUserMessages } from "../replay-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import {
  normalizeAssistantReplayContent,
  sanitizeGenericReplayHistory,
  sanitizeReplayHistoryAfterProviderHooks,
  type ReplayHistorySanitizers,
} from "./replay-history-sanitization.js";
import type { GenericReplayHistoryParams } from "./replay-history.types.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
} from "./thinking.js";

const policy: TranscriptPolicy = {
  sanitizeMode: "images-only",
  sanitizeToolCallIds: false,
  preserveNativeAnthropicToolUseIds: false,
  repairToolUseResultPairing: true,
  preserveSignatures: true,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: false,
  allowSyntheticToolResults: true,
};
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const assistant = (content: Parameters<typeof makeAssistantMessageFixture>[0]) =>
  makeAssistantMessageFixture({ stopReason: "stop", errorMessage: undefined, ...content });

function sanitize(messages: AgentMessage[], overrides: Partial<GenericReplayHistoryParams> = {}) {
  // Image decoding has its own boundary tests; this fixture leaves content intact while
  // checking the shared pipeline's placement, image limits, and resolved policy forwarding.
  const images = vi.fn<ReplayHistorySanitizers["sanitizeSessionMessagesImages"]>(
    async (rows) => rows,
  );
  const run = sanitizeGenericReplayHistory(
    {
      messages: annotateInterSessionUserMessages(messages),
      policy,
      imageLimits: { maxDimensionPx: 640, maxBytes: 1024 },
      signedThinkingProvider: false,
      allowProviderOwnedThinkingReplay: false,
      isOpenAIResponsesApi: true,
      ...overrides,
    },
    {
      sanitizeSessionMessagesImages: images,
      shouldPreserveLatestAssistantThinking,
      stripInvalidThinkingSignatures,
      dropReasoningFromHistory,
      dropThinkingBlocks,
    },
  );
  return { run, images };
}

describe("generic replay sanitization", () => {
  it("preserves provenance and replay/billing metadata while repairing content and ids", async () => {
    const replay = { type: "fixture-replay", v: 1, data: "opaque" };
    // Sparse legacy usage is deliberately accepted once at the transcript fixture boundary.
    const source = {
      ...assistant({ content: [call("call spaced")] }),
      providerReplay: replay,
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        contextUsage: { state: "available", promptTokens: 3, totalTokens: 5 },
        cost: { total: 0, totalOrigin: "provider-billed" },
      },
    } as unknown as AgentMessage;
    const user = {
      role: "user" as const,
      content: "context from another session",
      timestamp: 1,
      provenance: { kind: "inter_session", sourceSessionKey: "agent:fixture:other" },
    };
    const result = {
      role: "toolResult" as const,
      toolCallId: "call spaced",
      toolName: "read",
      content: [text("result")],
      details: { private: "not model context" },
      isError: false,
      timestamp: 2,
    };
    const messages = [user, source, result];
    const before = structuredClone(messages);
    const { run, images } = sanitize(messages);
    const sanitized = await run;
    expect(sanitized[0]).toMatchObject({
      provenance: user.provenance,
      content: expect.stringContaining("[Inter-session message]"),
    });
    expect(sanitized[1]).toMatchObject({
      providerReplay: replay,
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        contextUsage: { state: "available", promptTokens: 3, totalTokens: 5 },
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          totalOrigin: "provider-billed",
        },
      },
    });
    const normalizedId = expect.stringMatching(/^call_call_spaced_[0-9a-f]{10}$/);
    expect(sanitized[1]).toHaveProperty("content.0.id", normalizedId);
    expect(sanitized[2]).toMatchObject({ toolCallId: normalizedId, content: [text("result")] });
    expect(sanitized[2]).not.toHaveProperty("details");
    expect(messages).toEqual(before);
    expect(images).toHaveBeenCalledWith(expect.any(Array), "session:history", {
      sanitizeMode: "images-only",
      sanitizeToolCallIds: false,
      toolCallIdMode: undefined,
      duplicateToolCallIdStyle: undefined,
      preserveNativeAnthropicToolUseIds: false,
      preserveSignatures: true,
      sanitizeThoughtSignatures: undefined,
      maxDimensionPx: 640,
      maxBytes: 1024,
    });
  });

  it.each([true, false])("honors explicit latest-thinking preservation=%s", async (preserve) => {
    const thinking = { type: "thinking" as const, thinking: "unsigned reasoning" };
    const source = assistant({ content: [thinking, text("answer")] });
    const { run } = sanitize([source], {
      policy: { ...policy, preserveSignatures: false },
      signedThinkingProvider: true,
      preserveLatestAssistantThinking: preserve,
    });
    expect((await run)[0]).toHaveProperty("content", preserve ? source.content : [text("answer")]);
    expect(source.content).toEqual([thinking, text("answer")]);
  });

  it("keeps repair and post-hook assertion separate from generic preprocessing", async () => {
    const source = assistant({ content: [call("call_missing")], stopReason: "toolUse" });
    const noRepair = { ...policy, repairToolUseResultPairing: false };
    const messages = await sanitize([source], { policy: noRepair }).run;
    expect(() =>
      sanitizeReplayHistoryAfterProviderHooks(messages, {
        isOpenAIResponsesApi: true,
        policy: noRepair,
      }),
    ).toThrow("dangling_tool_call toolCallId=call_missing at message index 0");
    const repaired = sanitizeReplayHistoryAfterProviderHooks(messages, {
      isOpenAIResponsesApi: true,
      policy,
    });
    expect(repaired).toHaveLength(2);
    expect(repaired[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_missing",
      isError: true,
    });
    expect(messages).toEqual([source]);
    expect(
      sanitizeReplayHistoryAfterProviderHooks(messages, {
        isOpenAIResponsesApi: false,
        policy,
      }),
    ).toBe(messages);
  });

  it("applies the resolved switch timestamp without losing Responses phase metadata", async () => {
    const source = assistant({
      timestamp: 5,
      content: [
        {
          type: "thinking",
          thinking: "old reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_old", type: "reasoning" }),
        },
        {
          ...text("answer"),
          textSignature: JSON.stringify({ v: 1, id: "msg_old", phase: "final_answer" }),
        },
      ],
    });
    const sanitized = await sanitize([source], { latestModelSwitchTimestamp: 10 }).run;
    expect(sanitized[0]).toHaveProperty("content", [
      { ...text("answer"), textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
    ]);
    expect(source.content).toHaveLength(2);
    expect(source.content[1]).toHaveProperty("textSignature", expect.stringContaining("msg_old"));
  });

  it("reindexes compaction replay metadata through the canonical content replacement owner", () => {
    const source = {
      ...assistant({ content: [text("covered"), text("suffix")] }),
      content: [text("covered"), { type: "attachment", label: "display-only" }, text("suffix")],
      providerReplay: {
        type: "openai-responses-compaction",
        v: 1,
        data: "opaque-checkpoint",
        replayIndex: 2,
      },
    } as unknown as AgentMessage;
    const normalized = normalizeAssistantReplayContent([source]);
    expect(normalized[0]).toMatchObject({
      content: [text("covered"), text("suffix")],
      providerReplay: {
        type: "openai-responses-compaction",
        data: "opaque-checkpoint",
        replayIndex: 1,
      },
    });
    expect(source).toHaveProperty("providerReplay.replayIndex", 2);
  });

  it("keeps the shared normalizer's unchanged-history identity", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "question", timestamp: 1 },
      assistant({ content: [text("answer")] }),
    ];
    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });
});
