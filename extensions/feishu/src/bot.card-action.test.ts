import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";

// Mock resolveFeishuAccount
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

// Mock client.js for chat_type resolution
const mockChatGet = vi.fn();
vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn().mockReturnValue({
    im: { chat: { get: (...args: unknown[]) => mockChatGet(...args) } },
  }),
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action Handler", () => {
  const cfg = {} as any; // Minimal mock
  const runtime = { log: vi.fn(), error: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: API returns group chat_mode
    mockChatGet.mockResolvedValue({ code: 0, data: { chat_mode: "group" } });
  });

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            chat_id: "oc_chat1",
          }),
        }),
      }),
    );
  });

  it("handles card action with form_value (form submit)", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok3",
      action: {
        value: { command: "submit-form" },
        form_value: { field1: "hello", field2: "world" },
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    // Verify the merged object includes both value and form_value fields
    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_id).toBe("oc_chat1");
    const parsed = JSON.parse(JSON.parse(call.event.message.content).text);
    expect(parsed).toEqual({ command: "submit-form", field1: "hello", field2: "world" });
  });

  it("handles card action with empty form_value (fallback to value logic)", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: {
        value: { command: "simple-click" },
        form_value: {},
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"simple-click"}',
            chat_id: "oc_chat1",
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
      context: { open_id: "u123", user_id: "uid1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_id).toBe("u123"); // Fallback to open_id
    const parsed = JSON.parse(call.event.message.content);
    expect(parsed).toEqual({ text: JSON.stringify({ key: "val" }) });
  });

  it("uses open_message_id as message_id when available", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok5",
      action: { value: { text: "hello" }, tag: "button" },
      context: {
        open_id: "u123",
        user_id: "uid1",
        open_chat_id: "oc_chat1",
        open_message_id: "om_real123",
      },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.message_id).toBe("om_real123");
  });

  it("falls back to card-action-token when no open_message_id", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok6",
      action: { value: { text: "hello" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.message_id).toBe("card-action-tok6");
  });

  it("injects _card_message_id into content when form_value and open_message_id present", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok7",
      action: {
        value: { command: "confirm" },
        form_value: { answer: "yes" },
        tag: "button",
      },
      context: {
        open_id: "u123",
        user_id: "uid1",
        open_chat_id: "oc_chat1",
        open_message_id: "om_card456",
      },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    const parsed = JSON.parse(JSON.parse(call.event.message.content).text);
    expect(parsed).toEqual({
      command: "confirm",
      answer: "yes",
      _card_message_id: "om_card456",
    });
  });

  it("does not inject _card_message_id when no open_message_id", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok8",
      action: {
        value: { command: "confirm" },
        form_value: { answer: "yes" },
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    const parsed = JSON.parse(JSON.parse(call.event.message.content).text);
    expect(parsed).toEqual({ command: "confirm", answer: "yes" });
    expect(parsed._card_message_id).toBeUndefined();
  });

  it("resolves chat_type as group via API when chat_mode is group", async () => {
    mockChatGet.mockResolvedValue({ code: 0, data: { chat_mode: "group" } });

    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok9",
      action: { value: { text: "test" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_group1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_type).toBe("group");
    expect(mockChatGet).toHaveBeenCalledWith({ path: { chat_id: "oc_group1" } });
  });

  it("resolves chat_type as p2p via API when chat_mode is not group", async () => {
    mockChatGet.mockResolvedValue({ code: 0, data: { chat_mode: "p2p" } });

    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok10",
      action: { value: { text: "test" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_p2p1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_type).toBe("p2p");
  });

  it("defaults to p2p when chat API call fails", async () => {
    mockChatGet.mockRejectedValue(new Error("API timeout"));

    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok11",
      action: { value: { text: "test" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", open_chat_id: "oc_fail1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_type).toBe("p2p");
  });

  it("defaults to p2p when no open_chat_id (skips API call)", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok12",
      action: { value: { text: "test" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    expect(call.event.message.chat_type).toBe("p2p");
    expect(call.event.message.chat_id).toBe("u123"); // Fallback to open_id
    expect(mockChatGet).not.toHaveBeenCalled();
  });
});
