// Slack tests cover session transcript prompt context behavior.
import { readRecentUserAssistantTextForSession } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackSessionTranscriptHistoryEntries,
  mergeSlackSessionTranscriptInboundHistory,
} from "./session-transcript-context.js";

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecentUserAssistantTextForSessionMock = vi.mocked(readRecentUserAssistantTextForSession);

describe("buildSlackSessionTranscriptHistoryEntries", () => {
  beforeEach(() => {
    readRecentUserAssistantTextForSessionMock.mockReset();
  });

  it("maps assistant session turns without re-injecting persisted user prompts", async () => {
    readRecentUserAssistantTextForSessionMock.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        text: "Analyze this chart",
        timestamp: 1_000,
        sourceChannel: "gateway",
      },
      {
        id: "a1",
        role: "assistant",
        text: "The chart is range-bound; want an alert?",
        timestamp: 2_000,
      },
    ]);

    await expect(
      buildSlackSessionTranscriptHistoryEntries({
        agentId: "main",
        sessionKey: "agent:main:slack:channel:c123",
        storePath: "/tmp/sessions.json",
        beforeTimestampMs: 3_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        messageId: "session:a1",
        sender: "Assistant (assistant)",
        timestamp: 2_000,
        body: "The chart is range-bound; want an alert?",
      },
    ]);
    expect(readRecentUserAssistantTextForSessionMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:c123",
      storePath: "/tmp/sessions.json",
      limit: 10,
      role: "assistant",
      beforeTimestampMs: 3_000,
    });
  });

  it("forwards thread session keys unchanged to the SDK reader", async () => {
    readRecentUserAssistantTextForSessionMock.mockResolvedValue([]);

    await buildSlackSessionTranscriptHistoryEntries({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:c123:thread:100.000",
      storePath: "/tmp/sessions.json",
      beforeTimestampMs: 5_000,
      limit: 10,
    });

    expect(readRecentUserAssistantTextForSessionMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:c123:thread:100.000",
      storePath: "/tmp/sessions.json",
      limit: 10,
      role: "assistant",
      beforeTimestampMs: 5_000,
    });
  });
});

describe("mergeSlackSessionTranscriptInboundHistory", () => {
  it("returns the channel window unchanged when the session has no transcript turns", () => {
    const inboundHistory = [{ sender: "Alice", body: "hello", timestamp: 1_000 }];

    expect(mergeSlackSessionTranscriptInboundHistory({ sessionEntries: [], inboundHistory })).toBe(
      inboundHistory,
    );
    expect(
      mergeSlackSessionTranscriptInboundHistory({ sessionEntries: [], inboundHistory: undefined }),
    ).toBeUndefined();
  });

  it("dedupes transcript turns already present in the channel window by timestamp and text", () => {
    const merged = mergeSlackSessionTranscriptInboundHistory({
      sessionEntries: [
        {
          messageId: "session:u1",
          sender: "User (user)",
          body: "hello",
          timestamp: 1_000,
        },
        {
          messageId: "session:a1",
          sender: "Assistant (assistant)",
          body: "hi, want a summary?",
          timestamp: 2_000,
        },
      ],
      inboundHistory: [
        { sender: "Alice", body: "hello", timestamp: 1_000, messageId: "1.000" },
        { sender: "Alice", body: "yes please", timestamp: 3_000, messageId: "3.000" },
      ],
    });

    expect(merged).toEqual([
      { sender: "Alice", body: "hello", timestamp: 1_000, messageId: "1.000" },
      {
        messageId: "session:a1",
        sender: "Assistant (assistant)",
        body: "hi, want a summary?",
        timestamp: 2_000,
      },
      { sender: "Alice", body: "yes please", timestamp: 3_000, messageId: "3.000" },
    ]);
  });

  it("collapses duplicated transcript rows for the same turn", () => {
    // real transcripts can persist one turn twice (e.g. streamed replies);
    // observed on a production session store during PR verification
    const duplicatedReply = {
      sender: "Assistant (assistant)",
      body: "updated the record",
      timestamp: 2_000,
    };
    const merged = mergeSlackSessionTranscriptInboundHistory({
      sessionEntries: [
        {
          sender: "User (user)",
          body: "please update the record",
          timestamp: 1_000,
        },
        duplicatedReply,
        { ...duplicatedReply },
      ],
      inboundHistory: [
        { sender: "Alice", body: "unrelated", timestamp: 3_000, messageId: "3.000" },
      ],
    });

    expect(merged).toEqual([
      {
        sender: "User (user)",
        body: "please update the record",
        timestamp: 1_000,
      },
      duplicatedReply,
      { sender: "Alice", body: "unrelated", timestamp: 3_000, messageId: "3.000" },
    ]);
  });

  it("sorts merged entries chronologically and keeps untimestamped entries first", () => {
    const merged = mergeSlackSessionTranscriptInboundHistory({
      sessionEntries: [{ sender: "Assistant (assistant)", body: "later reply", timestamp: 5_000 }],
      inboundHistory: [
        { sender: "Alice", body: "no timestamp" },
        { sender: "Alice", body: "earlier message", timestamp: 1_000 },
      ],
    });

    expect(merged?.map((entry) => entry.body)).toEqual([
      "no timestamp",
      "earlier message",
      "later reply",
    ]);
  });

  it("caps the merged window to the configured history limit", () => {
    const merged = mergeSlackSessionTranscriptInboundHistory({
      sessionEntries: [
        { sender: "Assistant", body: "old reply", timestamp: 1_000 },
        { sender: "Assistant", body: "recent reply", timestamp: 3_000 },
      ],
      inboundHistory: [{ sender: "Alice", body: "middle message", timestamp: 2_000 }],
      limit: 2,
    });

    expect(merged?.map((entry) => entry.body)).toEqual(["middle message", "recent reply"]);
  });
});
