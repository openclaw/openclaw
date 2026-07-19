/**
 * Regression coverage for assistant reply history extraction.
 * Exercises run attribution, pagination bounds, and transcript-only mirrors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { readLatestAssistantReply, readLatestAssistantReplySnapshot } from "./run-wait.js";

type AgentWaitGatewayRequest = {
  params?: {
    offset?: number;
  };
};

const ATTRIBUTED_REPLY_HISTORY_MAX_PAGES = 20;
const ATTRIBUTED_REPLY_HISTORY_MAX_MESSAGES = 1_000;

function createRunTurnBoundary(runId: string, seq = 1) {
  return {
    role: "user",
    content: [{ type: "text", text: "run input" }],
    __openclaw: { idempotencyKey: `${runId}:user`, seq },
  };
}

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed and changes were pushed." }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("skips trailing transcript-only OpenClaw assistant mirrors for normal latest-reply reads", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "already delivered through message tool" }],
          openclawMessageToolMirror: {
            toolName: "message",
            toolCallId: "call-message-send",
          },
          timestamp: 11,
        },
        {
          role: "assistant",
          provider: "openclaw",
          model: "gateway-injected",
          content: [{ type: "text", text: "gateway notice" }],
          timestamp: 12,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("real worker reply");
  });

  it("skips trailing inter-session input rows for normal latest-reply reads", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "forwarded sessions_send prompt" }],
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:source",
            sourceTool: "sessions_send",
          },
          timestamp: 11,
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:target" });

    expect(result).toBe("older worker reply");
  });

  it("stops at trailing transcript artifacts for waited reply extraction", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "older worker reply" }],
          timestamp: 10,
        },
        {
          role: "assistant",
          provider: "openclaw",
          model: "gateway-injected",
          content: [{ type: "text", text: "gateway notice" }],
          timestamp: 11,
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:target",
      stopAtTranscriptArtifact: true,
    });

    expect(result).toEqual({});
  });

  it("returns assistant fingerprints for delta comparisons", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "new output" }],
          timestamp: 42,
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({ sessionKey: "agent:main:child" });

    expect(result.text).toBe("new output");
    expect(result.fingerprint).toContain('"timestamp":42');
  });

  it("does not attribute a concurrent projected turn's reply to the waited run", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          content: [{ type: "text", text: "waited request" }],
          __openclaw: { idempotencyKey: "run-waited:user", seq: 40 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "unrelated run reply" }],
          __openclaw: { seq: 41, turnBoundary: true },
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:target",
      stopAtTranscriptArtifact: true,
      attributableToRunId: "run-waited",
    });

    expect(result).toEqual({});
  });

  it("returns the first reply from an attributed run after a known-empty baseline", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          content: [{ type: "text", text: "first request" }],
          __openclaw: { idempotencyKey: "run-first:user", seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "first legitimate reply" }],
          __openclaw: { seq: 2 },
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:new-target",
      stopAtTranscriptArtifact: true,
      attributableToRunId: "run-first",
    });

    expect(result.text).toBe("first legitimate reply");
  });

  it("paginates past tool-heavy history while preserving newer turn boundaries", async () => {
    const toolMessages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "tool" : "toolResult",
      content: [{ type: "text", text: `tool output ${index + 1}` }],
      __openclaw: { seq: index + 4 },
    }));
    callGatewayMock
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "awaited final reply" }],
            __openclaw: { seq: 54 },
          },
          createRunTurnBoundary("run-concurrent", 55),
          {
            role: "assistant",
            content: [{ type: "text", text: "newer unrelated reply" }],
            __openclaw: { seq: 56 },
          },
        ],
        hasMore: true,
        nextOffset: 3,
        totalMessages: 56,
      })
      .mockResolvedValueOnce({
        messages: toolMessages,
        offset: 3,
        hasMore: true,
        nextOffset: 53,
        totalMessages: 56,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "previous turn" }],
            __openclaw: { seq: 1 },
          },
          createRunTurnBoundary("run-tool-heavy", 2),
          {
            role: "assistant",
            content: [{ type: "text", text: "working" }],
            __openclaw: { seq: 3 },
          },
        ],
        offset: 53,
        hasMore: false,
        totalMessages: 56,
      });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:tool-heavy",
      stopAtTranscriptArtifact: true,
      attributableToRunId: "run-tool-heavy",
    });

    expect(result.text).toBe("awaited final reply");
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "chat.history",
      params: { sessionKey: "agent:main:tool-heavy", limit: 50 },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "chat.history",
      params: { sessionKey: "agent:main:tool-heavy", limit: 50, offset: 3 },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(3, {
      method: "chat.history",
      params: { sessionKey: "agent:main:tool-heavy", limit: 50, offset: 53 },
    });
  });

  it("fails closed when an attributed history cursor does not advance", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "unattributed reply" }],
        },
      ],
      hasMore: true,
      nextOffset: 0,
      totalMessages: 10,
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:target",
      attributableToRunId: "run-missing",
    });

    expect(result).toEqual({});
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed after the bounded attributed history page walk", async () => {
    callGatewayMock.mockImplementation(async (request: AgentWaitGatewayRequest) => {
      if (callGatewayMock.mock.calls.length > ATTRIBUTED_REPLY_HISTORY_MAX_PAGES) {
        throw new Error("attributed history page walk exceeded its request budget");
      }
      const offset = request.params?.offset ?? 0;
      return {
        messages: [],
        offset,
        hasMore: true,
        nextOffset: offset + 1,
        totalMessages: Number.MAX_SAFE_INTEGER,
      };
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:missing-boundary",
      attributableToRunId: "run-missing",
    });

    expect(result).toEqual({});
    expect(callGatewayMock).toHaveBeenCalledTimes(ATTRIBUTED_REPLY_HISTORY_MAX_PAGES);
  });

  it("fails closed when one attributed history page exceeds the message budget", async () => {
    callGatewayMock.mockResolvedValue({
      messages: Array.from({ length: ATTRIBUTED_REPLY_HISTORY_MAX_MESSAGES + 1 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `unattributed reply ${index}` }],
      })),
      hasMore: true,
      nextOffset: ATTRIBUTED_REPLY_HISTORY_MAX_MESSAGES + 1,
      totalMessages: ATTRIBUTED_REPLY_HISTORY_MAX_MESSAGES + 2,
    });

    const result = await readLatestAssistantReplySnapshot({
      sessionKey: "agent:main:oversized-history-page",
      attributableToRunId: "run-missing",
    });

    expect(result).toEqual({});
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an attributed history page errors", async () => {
    callGatewayMock.mockRejectedValue(new Error("history unavailable"));

    await expect(
      readLatestAssistantReplySnapshot({
        sessionKey: "agent:main:history-error",
        attributableToRunId: "run-missing",
      }),
    ).resolves.toEqual({});
  });

  it("reads only final_answer text from phased assistant history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Fixed the quoting issue.",
              textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Fixed the quoting issue.");
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
            },
            {
              type: "text",
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Hi there");
  });
});
