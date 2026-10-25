import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleFeishuMessage } from "./bot.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import {
  createFeishuCardInteractionEnvelope as envelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";
import {
  expectFeishuCardButtonRow,
  expectFirstSentCardUsesFillWidthOnly,
} from "./card-test-helpers.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION as CANCEL,
  FEISHU_APPROVAL_CONFIRM_ACTION as CONFIRM,
  FEISHU_APPROVAL_REQUEST_ACTION as REQUEST,
} from "./card-ux-approval.js";

const { createClient, getChat, sendCard, sendMessage } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getChat: vi.fn(),
  sendCard: vi.fn<typeof import("./send.js").sendCardFeishu>(),
  sendMessage: vi.fn<typeof import("./send.js").sendMessageFeishu>(),
}));
// mock-isolation: Pin the selected account without consulting operator configuration.
vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));
vi.mock("./bot.js", () => ({ handleFeishuMessage: vi.fn() }));
// mock-isolation: Resolve chat metadata through the fixture client, never the Feishu API.
vi.mock("./client.js", () => ({ createFeishuClient: createClient }));
// mock-isolation: Observe card and message sends without external delivery.
vi.mock("./send.js", () => ({
  sendCardFeishu: sendCard,
  sendMessageFeishu: sendMessage,
}));

describe("Feishu Card Action Handler", () => {
  const log = vi.fn();
  const runtime = { ...createRuntimeEnv(), log };
  const maxDate = 8_640_000_000_000_000;
  const context = () => ({ u: "u123", h: "chat1", e: Date.now() + 60_000 });
  const quickAction = (overrides: Partial<Omit<FeishuCardInteractionEnvelope, "oc">> = {}) =>
    envelope({
      k: "quick",
      a: "feishu.quick_actions.help",
      q: "/help",
      c: { ...context(), t: "group" },
      ...overrides,
    });
  const approvalAction = (expiresAt = Date.now() + 60_000) =>
    envelope({
      k: "meta",
      a: REQUEST,
      m: { command: "/new", prompt: "Start?" },
      c: { ...context(), s: "session", e: expiresAt },
    });
  const cardEvent = (
    value: Record<string, unknown> = quickAction(),
    overrides: Partial<FeishuCardActionEvent> = {},
  ): FeishuCardActionEvent => ({
    operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
    token: "callback-token",
    action: { value, tag: "button" },
    context: { chat_id: "chat1" },
    ...overrides,
  });
  const dispatch = (
    event = cardEvent(),
    options: Omit<Parameters<typeof handleFeishuCardAction>[0], "cfg" | "event"> = {},
  ) => handleFeishuCardAction({ cfg: {}, event, runtime, ...options });
  const inbound = () => vi.mocked(handleFeishuMessage).mock.calls[0]?.[0].event;
  const message = () => inbound()?.message;
  const expectNotice = (text: unknown) =>
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ to: "chat:chat1", text });

  beforeEach(() => {
    vi.clearAllMocks();
    getChat.mockReset().mockResolvedValue({ code: 0, data: { chat_type: "group" } });
    createClient.mockReset().mockReturnValue({ im: { chat: { get: getChat } } });
    vi.mocked(handleFeishuMessage).mockReset().mockResolvedValue(undefined);
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
  });

  it("handles card action with JSON object payload without logging content", async () => {
    await dispatch(cardEvent({ a: "b" }, { context: { chat_id: "" } }));
    expect(message()).toMatchObject({ content: '{"text":"{\\"a\\":\\"b\\"}"}', chat_id: "u123" });
    expect(log.mock.calls.flat().join("\n")).not.toContain('{"a":"b"}');
  });

  it("opens approval cards with resolved DM type and preserved interaction context", async () => {
    getChat.mockResolvedValueOnce({ code: 0, data: { chat_mode: "p2p" } });
    await dispatch(cardEvent(approvalAction()), { accountId: "main" });
    const expected = { u: "u123", h: "chat1", t: "p2p", s: "session", e: expect.any(Number) };
    const sent = sendCard.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      to: "chat:chat1",
      accountId: "main",
      card: { header: { title: { content: "Confirm action" } } },
    });
    const buttons = expectFeishuCardButtonRow(sent?.card);
    expect(buttons.map((button) => button.value)).toEqual([
      expect.objectContaining({ a: CONFIRM, q: "/new", c: expected }),
      expect.objectContaining({ a: CANCEL, c: expected }),
    ]);
    expectFirstSentCardUsesFillWidthOnly(sendCard);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it.each(["confirm", "cancel"] as const)(
    "dispatches the emitted approval %s button",
    async (action) => {
      await dispatch(cardEvent(approvalAction()));
      const buttons = expectFeishuCardButtonRow(sendCard.mock.calls[0]?.[0]?.card);
      const button = buttons[action === "confirm" ? 0 : 1];
      const event = cardEvent(button?.value as Record<string, unknown>, {
        token: "approval-callback",
      });
      await dispatch(event, { botOpenId: "ou_bot" });
      await dispatch(event, { botOpenId: "ou_bot" });
      if (action === "confirm") {
        expect(message()).toMatchObject({
          chat_id: "chat1",
          chat_type: "group",
          content: '{"text":"/new"}',
        });
        expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
      } else {
        expectNotice("Cancelled.");
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(handleFeishuMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("does not open approval cards when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers({ now: maxDate });
    await dispatch(cardEvent(approvalAction(maxDate)), { accountId: "main" });
    expect(sendCard).not.toHaveBeenCalled();
    expectNotice(expect.stringContaining("payload is invalid"));
  });

  it("marks synthetic group card callbacks as mentioning the bot", async () => {
    await dispatch(
      cardEvent(quickAction({ a: CONFIRM, q: "/new" }), { open_message_id: "om_card" }),
      { botOpenId: "ou_bot" },
    );
    expect(message()).toMatchObject({
      chat_id: "chat1",
      chat_type: "group",
      reply_target_message_id: "om_card",
      typing_target_message_id: "om_card",
      content: '{"text":"/new"}',
    });
    const sender = inbound()?.sender.sender_id;
    expect(sender).toEqual({ open_id: "u123", user_id: "uid1", union_id: "un1" });
    expect(message()?.mentions).toEqual([
      { key: "mention_bot", id: { open_id: "ou_bot" }, name: "bot" },
    ]);
  });

  it.each(["expired", "different user", "different conversation"] as const)(
    "rejects an emitted approval belonging to %s",
    async (reason) => {
      vi.useFakeTimers({ now: 100 });
      await dispatch(cardEvent(approvalAction()));
      const [button] = expectFeishuCardButtonRow(sendCard.mock.calls[0]?.[0]?.card);
      if (reason === "expired") {
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      }
      const event = cardEvent(button?.value as Record<string, unknown>, {
        token: "rejected-approval",
        ...(reason === "different user" ? { operator: { open_id: "u999" } } : {}),
        ...(reason === "different conversation" ? { context: { chat_id: "chat2" } } : {}),
      });
      await dispatch(event);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        to: reason === "different conversation" ? "chat:chat2" : "chat:chat1",
        text: expect.stringContaining(reason),
      });
      expect(handleFeishuMessage).not.toHaveBeenCalled();
    },
  );

  it("preserves p2p callbacks for DM quick actions", async () => {
    await dispatch(cardEvent(quickAction({ c: { ...context(), t: "p2p" } })), {
      botOpenId: "ou_bot",
    });
    expect(message()).toMatchObject({ chat_id: "chat1", chat_type: "p2p" });
    expect(message()?.mentions).toBeUndefined();
  });

  it("does not cache chat types or callback tokens when expiry would exceed a valid Date", async () => {
    vi.useFakeTimers({ now: maxDate });
    getChat.mockResolvedValue({ code: 0, data: { chat_type: "p2p" } });
    const event = cardEvent({ text: "/help" });
    await dispatch(event);
    await dispatch(event);
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
    expect(message()).toMatchObject({ chat_id: "chat1", chat_type: "p2p" });
  });

  it.each(["response", "exception"])("falls back to p2p after chat lookup %s", async (failure) => {
    const detail = "private-card-provider-detail";
    if (failure === "response") {
      getChat.mockResolvedValueOnce({ code: 99, msg: detail });
    } else {
      getChat.mockRejectedValueOnce(new Error(detail));
    }
    await dispatch(cardEvent({ text: "/help" }));
    expect(message()?.chat_type).toBe("p2p");
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: failed to resolve chat type; defaulting to p2p",
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain(detail);
  });

  it("does not log raw duplicate callback tokens", async () => {
    const event = cardEvent();
    await dispatch(event);
    await dispatch(event);
    const logs = log.mock.calls.flat().join("\n");
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(logs).toContain("skipping duplicate card action token");
    expect(logs).not.toContain(event.token);
  });

  it("rejects empty callback tokens before dispatch", async () => {
    await dispatch(cardEvent(quickAction(), { token: "   " }));
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: rejected card action from u123: missing token",
    );
  });

  it("keeps a claimed token completed after a non-retryable dispatch failure", async () => {
    vi.mocked(handleFeishuMessage).mockRejectedValueOnce(new Error("transient"));
    const event = cardEvent();
    await expect(dispatch(event)).rejects.toThrow("transient");
    await dispatch(event);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight token claimed while a slow dispatch is still running", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<void>();
    vi.mocked(handleFeishuMessage).mockReturnValue(pending.promise);
    const event = cardEvent();
    const first = dispatch(event);
    await vi.advanceTimersByTimeAsync(61_000);
    await dispatch(event);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
  });
});
