import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(() => true),
  runInboundClaim: vi.fn(async () => undefined),
  runMessageReceived: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: () => hookRunner };
});

const { emitTelegramLiveLocationMessageHook } = await import("./location-message-hook.js");

function emitLocation(
  fields: Partial<Message> = {},
  updateId = 9002,
  updateKind: "edited_message" | "edited_channel_post" = "edited_message",
) {
  return emitTelegramLiveLocationMessageHook({
    accountId: "main",
    updateId,
    updateKind,
    isForum: false,
    msg: {
      chat: { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_520,
      from: { id: 789, is_bot: false, first_name: "Pat" },
      location: { latitude: 43.8376, longitude: 18.4534, live_period: 900 },
      ...fields,
    } as Message,
  });
}

describe("Telegram location message hooks", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockClear();
    hookRunner.runInboundClaim.mockClear();
    hookRunner.runMessageReceived.mockReset();
    hookRunner.runMessageReceived.mockResolvedValue(undefined);
  });

  it("ignores non-location edits", () => {
    emitLocation({ location: undefined, text: "edited text" });

    expect(hookRunner.runMessageReceived).not.toHaveBeenCalled();
  });

  it.each([
    [
      "edited_message",
      9002,
      {
        location: {
          latitude: 43.8376,
          longitude: 18.4534,
          horizontal_accuracy: 12,
          live_period: 900,
        },
      },
      true,
    ],
    ["edited_message", 9003, { location: { latitude: 43.8376, longitude: 18.4534 } }, false],
    [
      "edited_channel_post",
      9004,
      {
        chat: { id: -1001234, type: "supergroup", title: "Travel updates" },
        from: { id: 789, is_bot: true, first_name: "Travel updates" },
      },
      true,
    ],
  ] satisfies ["edited_message" | "edited_channel_post", number, Partial<Message>, boolean][])(
    "emits %s location update %i without dispatching inbound claims",
    (kind, id, fields, isLive) => {
      emitLocation(fields, id, kind);
      expect(hookRunner.hasHooks).toHaveBeenCalledWith("message_received", expect.any(Object));
      expect(hookRunner.runMessageReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "456",
          senderId: "789",
          timestamp: 1_786_094_520_000,
          location: expect.objectContaining({
            latitude: 43.8376,
            longitude: 18.4534,
            isLive,
            ...(id === 9002 ? { accuracy: 12, source: "live", livePeriodSeconds: 900 } : {}),
          }),
          providerUpdate: {
            id: String(id),
            kind,
            messageId: "456",
            messageTimestamp: 1_786_094_460_000,
            editedTimestamp: 1_786_094_520_000,
          },
        }),
        expect.objectContaining({
          channelId: "telegram",
          accountId: "main",
          ...(id === 9002 ? { conversationId: "telegram:1234" } : {}),
          messageId: "456",
          senderId: "789",
        }),
      );
      expect(hookRunner.runInboundClaim).not.toHaveBeenCalled();
    },
  );

  it("does not wait for plugin observers on the Telegram inbound path", () => {
    hookRunner.runMessageReceived.mockReturnValueOnce(new Promise(() => {}));
    expect(emitLocation({}, 9005)).toBeUndefined();
    expect(hookRunner.runMessageReceived).toHaveBeenCalledTimes(1);
  });
});
