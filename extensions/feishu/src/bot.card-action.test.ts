import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFeishuMessage } from "./bot.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import {
  createFeishuCardInteractionEnvelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";
import {
  expectFirstSentCardUsesFillWidthOnly,
  expectSentCardHasP2pAction,
} from "./card-test-helpers.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";

const { createFeishuClientMock, getChat, sendCardFeishuMock, sendMessageFeishuMock } = vi.hoisted(
  () => ({
    createFeishuClientMock: vi.fn(),
    getChat: vi.fn(),
    sendCardFeishuMock: vi.fn<typeof import("./send.js").sendCardFeishu>(),
    sendMessageFeishuMock: vi.fn<typeof import("./send.js").sendMessageFeishu>(),
  }),
);
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));
vi.mock("./bot.js", () => ({ handleFeishuMessage: vi.fn() }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

describe("Feishu Card Action Handler", () => {
  const runtime = createRuntimeEnv();
  const maxDate = 8_640_000_000_000_000;
  const context = () => ({ u: "u123", h: "chat1", e: Date.now() + 60_000 });
  const quickAction = (overrides: Partial<Omit<FeishuCardInteractionEnvelope, "oc">> = {}) =>
    createFeishuCardInteractionEnvelope({
      k: "quick",
      a: "feishu.quick_actions.help",
      q: "/help",
      c: { ...context(), t: "group" },
      ...overrides,
    });
  const approvalAction = (expiresAt = Date.now() + 60_000) =>
    createFeishuCardInteractionEnvelope({
      k: "meta",
      a: FEISHU_APPROVAL_REQUEST_ACTION,
      m: { command: "/new", prompt: "Start a fresh session?" },
      c: { ...context(), s: "agent:codex:feishu:chat:chat1", e: expiresAt },
    });
  const cardEvent = (
    value: Record<string, unknown> = quickAction(),
    overrides: Partial<FeishuCardActionEvent> = {},
  ): FeishuCardActionEvent => ({
    operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
    token: "callback-token",
    action: { value, tag: "button" },
    context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    ...overrides,
  });
  const dispatch = (
    event = cardEvent(),
    options: Omit<Parameters<typeof handleFeishuCardAction>[0], "cfg" | "event"> = {},
  ) => handleFeishuCardAction({ cfg: {}, event, runtime, ...options });
  const message = () => vi.mocked(handleFeishuMessage).mock.calls[0]?.[0].event.message;
  const notice = () => sendMessageFeishuMock.mock.calls[0]?.[0];

  beforeEach(() => {
    vi.clearAllMocks();
    getChat.mockReset().mockResolvedValue({ code: 0, data: { chat_type: "group" } });
    createFeishuClientMock.mockReset().mockReturnValue({ im: { chat: { get: getChat } } });
    vi.mocked(handleFeishuMessage).mockReset().mockResolvedValue(undefined);
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./bot.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  it("handles card action with JSON object payload", async () => {
    await dispatch(cardEvent({ key: "val" }, { context: { chat_id: "" } }));
    expect(message()).toMatchObject({
      content: '{"text":"{\\"key\\":\\"val\\"}"}',
      chat_id: "u123",
    });
  });

  it("opens approval cards with resolved DM type and preserved interaction context", async () => {
    getChat.mockResolvedValueOnce({ code: 0, data: { chat_mode: "p2p" } });
    await dispatch(cardEvent(approvalAction()), { accountId: "main" });
    expect(sendCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      to: "chat:chat1",
      accountId: "main",
      card: {
        config: { width_mode: "fill" },
        header: { title: { content: "Confirm action" } },
        body: {
          elements: expect.arrayContaining([
            {
              tag: "action",
              actions: [
                expect.objectContaining({
                  value: expect.objectContaining({
                    c: {
                      u: "u123",
                      h: "chat1",
                      t: "p2p",
                      s: "agent:codex:feishu:chat:chat1",
                      e: expect.any(Number),
                    },
                  }),
                }),
                expect.anything(),
              ],
            },
          ]),
        },
      },
    });
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
    expectSentCardHasP2pAction(sendCardFeishuMock);
    expect(createFeishuClientMock).toHaveBeenCalledTimes(1);
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("does not open approval cards when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(maxDate);
    await dispatch(cardEvent(approvalAction(maxDate)), { accountId: "main" });
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(notice()).toMatchObject({
      to: "chat:chat1",
      text: expect.stringContaining("payload is invalid"),
    });
  });

  it("marks synthetic group card callbacks as mentioning the bot", async () => {
    await dispatch(
      cardEvent(quickAction({ a: FEISHU_APPROVAL_CONFIRM_ACTION, q: "/new" }), {
        open_message_id: "om_card_message",
      }),
      {
        botOpenId: "ou_bot",
      },
    );
    expect(message()).toMatchObject({
      chat_id: "chat1",
      chat_type: "group",
      reply_target_message_id: "om_card_message",
      typing_target_message_id: "om_card_message",
      content: '{"text":"/new"}',
    });
    expect(vi.mocked(handleFeishuMessage).mock.calls[0]?.[0].event.sender.sender_id).toEqual({
      open_id: "u123",
      user_id: "uid1",
      union_id: "un1",
    });
    expect(message()?.mentions).toEqual([
      { key: "mention_bot", id: { open_id: "ou_bot" }, name: "bot" },
    ]);
  });

  it.each([
    {
      name: "stale",
      c: () => ({ ...context(), t: "group" as const, e: Date.now() - 1 }),
      reason: "expired",
    },
    {
      name: "wrong-user",
      c: () => ({ ...context(), t: "group" as const, u: "u999" }),
      reason: "different user",
    },
  ])("safely rejects $name structured actions", async ({ c, reason }) => {
    await dispatch(cardEvent(quickAction({ c: c() })));
    expect(notice()).toMatchObject({ to: "chat:chat1", text: expect.stringContaining(reason) });
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("sends a lightweight cancellation notice", async () => {
    await dispatch(
      cardEvent(quickAction({ k: "button", a: FEISHU_APPROVAL_CANCEL_ACTION, q: undefined })),
    );
    expect(notice()).toMatchObject({ to: "chat:chat1", text: "Cancelled." });
  });

  it("preserves p2p callbacks for DM quick actions", async () => {
    const event = cardEvent(quickAction({ c: { ...context(), h: "p2p-chat-1", t: "p2p" } }), {
      context: { chat_id: "p2p-chat-1" },
    });
    await dispatch(event, { botOpenId: "ou_bot" });
    expect(message()).toMatchObject({ chat_id: "p2p-chat-1", chat_type: "p2p" });
    expect(message()?.mentions).toBeUndefined();
  });

  it("does not cache resolved chat type when expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(maxDate);
    getChat.mockResolvedValue({ code: 0, data: { chat_type: "p2p" } });
    const event = cardEvent({ text: "/help" }, { context: { chat_id: "oc_dm_chat_boundary" } });
    await dispatch(event);
    await dispatch({ ...event, token: "second-token" });
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
    expect(message()).toMatchObject({ chat_id: "oc_dm_chat_boundary", chat_type: "p2p" });
  });

  it("keeps Feishu chat lookup error logs UTF-16 safe at the truncation boundary", async () => {
    const log = vi.fn();
    getChat.mockResolvedValueOnce({ code: 99, msg: `${"x".repeat(499)}😀tail` });
    await dispatch(cardEvent({ text: "/help" }), { runtime: { ...runtime, log } });
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(notice()?.text).toContain("Could not verify");
    expect(log).toHaveBeenCalledWith(
      `feishu[mock-account]: card action chat type unavailable: ${"x".repeat(499)}; action refused`,
    );
  });

  it("does not run a card action when Feishu chat lookup fails", async () => {
    getChat.mockRejectedValueOnce(new Error("network failure"));
    await dispatch(cardEvent({ text: "/help" }));
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(notice()).toMatchObject({
      to: "chat:chat1",
      text: expect.stringContaining("Could not verify"),
    });
  });

  it("does not open an approval card when the chat type is missing", async () => {
    getChat.mockResolvedValueOnce({ code: 0, data: {} });
    await dispatch(cardEvent(approvalAction()));
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(notice()?.text).toContain("Could not verify");
  });

  it("keeps an explicit group card action when chat lookup fails", async () => {
    getChat.mockRejectedValueOnce(new Error("network failure"));
    await dispatch(cardEvent(quickAction()));
    expect(message()?.chat_type).toBe("group");
    expect(notice()).toBeUndefined();
  });

  it("does not log raw duplicate callback tokens", async () => {
    const log = vi.fn();
    const event = cardEvent();
    await dispatch(event, { runtime: { ...runtime, log } });
    await dispatch(event, { runtime: { ...runtime, log } });
    const logs = log.mock.calls.flat().join("\n");
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(logs).toContain("skipping duplicate card action token");
    expect(logs).not.toContain(event.token);
  });

  it("does not cache callback tokens when token ttl expiry overflows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(maxDate);
    const event = cardEvent({ text: "/help" });
    await dispatch(event);
    await dispatch(event);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects empty callback tokens before dispatch", async () => {
    const log = vi.fn();
    await dispatch(cardEvent(quickAction(), { token: "   " }), { runtime: { ...runtime, log } });
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
