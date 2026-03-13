import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  makeMockSessionManager,
  TEST_SESSION_ID,
} from "../pi-embedded-runner.sanitize-session-history.test-harness.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import { sanitizeSessionHistory } from "./google.js";
import { limitHistoryTurns } from "./history.js";
import { latestAssistantMessageHasReplayProtectedBlocks } from "./thinking.js";

function getLatestAssistant(messages: AgentMessage[]) {
  return messages.findLast((message) => message.role === "assistant");
}

describe("replay-protection transcript pipeline", () => {
  it("keeps the latest Anthropic thinking block byte-identical through sanitizeSessionHistory", async () => {
    const latestAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
        { type: "text", text: "final" },
      ],
    };
    const messages = castAgentMessages([{ role: "user", content: "hello" }, latestAssistant]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

    expect(JSON.stringify(getLatestAssistant(sanitized)?.content)).toBe(
      JSON.stringify(latestAssistant.content),
    );
  });

  it("keeps the latest Anthropic redacted_thinking block byte-identical through sanitizeSessionHistory", async () => {
    const latestAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "final" },
        { type: "redacted_thinking", data: "opaque" },
      ],
    };
    const messages = castAgentMessages([{ role: "user", content: "hello" }, latestAssistant]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

    expect(JSON.stringify(getLatestAssistant(sanitized)?.content)).toBe(
      JSON.stringify(latestAssistant.content),
    );
  });

  it("preserves latest non-thinking content for github-copilot while still dropping thinking blocks", async () => {
    const latestAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_latest", name: " exec ", arguments: { cmd: "ls" } },
        { type: "text", text: "visible" },
      ],
    };
    const messages = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "older-internal" },
          { type: "text", text: "older" },
        ],
      },
      latestAssistant,
    ]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "github-copilot",
      modelId: "claude-opus-4.6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

    expect(getLatestAssistant(sanitized)?.content).toEqual([
      { type: "toolCall", id: "call_latest", name: " exec ", arguments: { cmd: "ls" } },
      { type: "text", text: "visible" },
    ]);
  });

  it("recomputes replay protection correctly after limitHistoryTurns truncation", () => {
    const replayProtectedContent = [
      { type: "thinking", thinking: "deep thought", thinkingSignature: "sig" },
      { type: "text", text: "final answer" },
    ];
    const input = castAgentMessages([
      { role: "user", content: "old turn" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "exec", arguments: {} }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "exec",
        content: [{ type: "text", text: "old result" }],
        isError: false,
      },
      { role: "user", content: "recent turn" },
      { role: "assistant", content: replayProtectedContent },
    ]);

    const truncated = limitHistoryTurns(input, 1);
    const repaired = sanitizeToolUseResultPairing(truncated, {
      preserveLatestAssistantMessage: latestAssistantMessageHasReplayProtectedBlocks(truncated),
    });

    expect(JSON.stringify(getLatestAssistant(repaired)?.content)).toBe(
      JSON.stringify(replayProtectedContent),
    );
  });

  it("keeps the latest replay-protected assistant intact when compaction summaries exist", async () => {
    const latestAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "new reasoning", thinkingSignature: "sig" },
        { type: "text", text: "new answer" },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-6",
    };
    const messages = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "stale usage" }],
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      { role: "compactionSummary", summary: "compressed", tokensBefore: 500, timestamp: "2" },
      { role: "user", content: "latest question" },
      latestAssistant,
    ]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

    expect(JSON.stringify(getLatestAssistant(sanitized)?.content)).toBe(
      JSON.stringify(latestAssistant.content),
    );
  });
});
