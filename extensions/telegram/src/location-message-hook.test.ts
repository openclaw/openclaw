import type { Message } from "grammy/types";
import { beforeEach, expect, it, vi } from "vitest";

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
const coordinates = { latitude: 43.8376, longitude: 18.4534 };

function emitLocation(mode: "live" | "stopped" | "channel" | "text" = "live") {
  return emitTelegramLiveLocationMessageHook({
    accountId: "main",
    updateId: 9002,
    updateKind: mode === "channel" ? "edited_channel_post" : "edited_message",
    isForum: false,
    msg: {
      chat:
        mode === "channel"
          ? { id: -1001234, type: "supergroup", title: "Travel updates" }
          : { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_520,
      from: { id: 789, is_bot: mode === "channel", first_name: "Pat" },
      location:
        mode === "text"
          ? undefined
          : {
              ...coordinates,
              ...(mode !== "stopped" ? { live_period: 900 } : {}),
              ...(mode === "live" ? { horizontal_accuracy: 12 } : {}),
            },
      text: mode === "text" ? "edited text" : undefined,
    } as Message,
  });
}

beforeEach(() => {
  for (const hook of Object.values(hookRunner)) {
    hook.mockClear();
  }
});

it("ignores non-location edits", () => {
  emitLocation("text");

  expect(hookRunner.runMessageReceived).not.toHaveBeenCalled();
});

it.each(["live", "stopped", "channel"] as const)(
  "emits a %s location without dispatching inbound claims",
  (mode) => {
    const kind = mode === "channel" ? "edited_channel_post" : "edited_message";
    emitLocation(mode);
    expect(hookRunner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "456",
        senderId: "789",
        timestamp: 1_786_094_520_000,
        location: expect.objectContaining({
          ...coordinates,
          isLive: mode !== "stopped",
          ...(mode === "live" ? { accuracy: 12, source: "live", livePeriodSeconds: 900 } : {}),
        }),
        providerUpdate: {
          id: "9002",
          kind,
          messageId: "456",
          messageTimestamp: 1_786_094_460_000,
          editedTimestamp: 1_786_094_520_000,
        },
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "main",
        ...(mode === "live" ? { conversationId: "telegram:1234" } : {}),
        messageId: "456",
        senderId: "789",
      }),
    );
    expect(hookRunner.runInboundClaim).not.toHaveBeenCalled();
  },
);

it("does not wait for plugin observers on the Telegram inbound path", () => {
  hookRunner.runMessageReceived.mockReturnValueOnce(new Promise(() => {}));
  expect(emitLocation()).toBeUndefined();
  expect(hookRunner.runMessageReceived).toHaveBeenCalledTimes(1);
});
