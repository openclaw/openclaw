import { describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

const transcribeFirstAudioMock = vi.fn();

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

const { resolveTelegramInboundBody } = await import("./bot-message-context.body.js");

describe("resolveTelegramInboundBody", () => {
  it("does not transcribe group audio for unauthorized senders", async () => {
    transcribeFirstAudioMock.mockReset();
    const logger = { info: vi.fn() };

    const result = await resolveTelegramInboundBody({
      cfg: {
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      } as never,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      msg: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        from: { id: 46, first_name: "Eve" },
        voice: { file_id: "voice-1" },
        entities: [],
      } as never,
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      isGroup: true,
      chatId: -1001234567890,
      senderId: "46",
      senderUsername: "",
      routeAgentId: undefined,
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      effectiveDmAllow: normalizeAllowFrom([]),
      groupConfig: { requireMention: true } as never,
      topicConfig: undefined,
      requireMention: true,
      options: undefined,
      groupHistories: new Map(),
      historyLimit: 0,
      logger,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: -1001234567890, reason: "no-mention" },
      "skipping group message",
    );
    expect(result).toBeNull();
  });

  it("still transcribes when commands.useAccessGroups is false", async () => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const result = await resolveTelegramInboundBody({
      cfg: {
        channels: { telegram: {} },
        commands: { useAccessGroups: false },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
        tools: { media: { audio: { enabled: true } } },
      } as never,
      primaryCtx: {
        me: { id: 7, username: "bot" },
      } as never,
      msg: {
        message_id: 2,
        date: 1_700_000_001,
        chat: { id: -1001234567891, type: "supergroup", title: "Test Group" },
        from: { id: 46, first_name: "Eve" },
        voice: { file_id: "voice-2" },
        entities: [],
      } as never,
      allMedia: [{ path: "/tmp/voice-2.ogg", contentType: "audio/ogg" }],
      isGroup: true,
      chatId: -1001234567891,
      senderId: "46",
      senderUsername: "",
      routeAgentId: undefined,
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      effectiveDmAllow: normalizeAllowFrom([]),
      groupConfig: { requireMention: true } as never,
      topicConfig: undefined,
      requireMention: true,
      options: undefined,
      groupHistories: new Map(),
      historyLimit: 0,
      logger: { info: vi.fn() },
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      bodyText: "hey bot please help",
      effectiveWasMentioned: true,
    });
  });
});
