import { readRecentUserAssistantTextForSession } from "openclaw/plugin-sdk/session-store-runtime";
// Telegram session transcript context tests cover shared direct-session prompt context mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramSessionTranscriptPromptMessages } from "./session-transcript-context.js";

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecentUserAssistantTextForSessionMock = vi.mocked(readRecentUserAssistantTextForSession);

describe("buildTelegramSessionTranscriptPromptMessages", () => {
  beforeEach(() => {
    readRecentUserAssistantTextForSessionMock.mockReset();
  });

  it("maps shared session turns into chronological Telegram prompt messages", async () => {
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
      buildTelegramSessionTranscriptPromptMessages({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/sessions.json",
        beforeTimestampMs: 3_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        message_id: "session:u1",
        sender: "User (gateway)",
        timestamp_ms: 1_000,
        body: "Analyze this chart",
        source_channel: "gateway",
      },
      {
        message_id: "session:a1",
        sender: "OpenClaw",
        timestamp_ms: 2_000,
        body: "The chart is range-bound; want an alert?",
      },
    ]);
    expect(readRecentUserAssistantTextForSessionMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      limit: 10,
      beforeTimestampMs: 3_000,
    });
  });
});
