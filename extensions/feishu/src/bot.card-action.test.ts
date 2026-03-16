import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleFeishuCardAction,
  resetProcessedFeishuCardActionTokensForTests,
  type FeishuCardActionEvent,
} from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";

// Mock resolveFeishuAccount
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action Handler", () => {
  const cfg = {} as any; // Minimal mock
  const runtime = { log: vi.fn(), error: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessedFeishuCardActionTokensForTests();
  });

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            chat_id: "chat1",
          }),
        }),
      }),
    );
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok2",
      action: { value: { key: "val" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"{\\"key\\":\\"val\\"}"}',
            chat_id: "u123", // Fallback to open_id
          }),
        }),
      }),
    );
  });

  it("routes quick command actions with operator and conversation context", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok3",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          sender: expect.objectContaining({
            sender_id: expect.objectContaining({
              open_id: "u123",
              user_id: "uid1",
              union_id: "un1",
            }),
          }),
          message: expect.objectContaining({
            chat_id: "chat1",
            content: '{"text":"/help"}',
          }),
        }),
      }),
    );
  });

  it("opens an approval card for metadata actions", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "meta",
          a: FEISHU_APPROVAL_REQUEST_ACTION,
          m: {
            command: "/new",
            prompt: "Start a fresh session?",
          },
          c: {
            u: "u123",
            h: "chat1",
            t: "group",
            s: "agent:codex:feishu:chat:chat1",
            e: Date.now() + 60_000,
          },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime, accountId: "main" });

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        accountId: "main",
        card: expect.objectContaining({
          header: expect.objectContaining({
            title: expect.objectContaining({ content: "Confirm action" }),
          }),
          body: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    value: expect.objectContaining({
                      c: expect.objectContaining({
                        u: "u123",
                        h: "chat1",
                        t: "group",
                        s: "agent:codex:feishu:chat:chat1",
                      }),
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        }),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("runs approval confirmation through the normal message path", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok5",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: FEISHU_APPROVAL_CONFIRM_ACTION,
          q: "/new",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/new"}',
          }),
        }),
      }),
    );
  });

  it("safely rejects stale structured actions", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok6",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() - 1 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        text: expect.stringContaining("expired"),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("safely rejects wrong-user structured actions", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u999", user_id: "uid1", union_id: "un1" },
      token: "tok7",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u999", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("different user"),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("sends a lightweight cancellation notice", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok8",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "button",
          a: FEISHU_APPROVAL_CANCEL_ACTION,
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        text: "Cancelled.",
      }),
    );
  });

  it("preserves p2p callbacks for DM quick actions", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok9",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "p2p-chat-1", t: "p2p", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "p2p-chat-1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "p2p-chat-1",
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("drops duplicate structured callback tokens", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok10",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("releases a claimed token when dispatch fails so retries can succeed", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok11",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };
    vi.mocked(handleFeishuMessage)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined as never);

    await expect(handleFeishuCardAction({ cfg, event, runtime })).rejects.toThrow("transient");
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
  });
});
