import { describe, it, expect, vi } from "vitest";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";

// Mock resolveFeishuAccount
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action Handler", () => {
  const cfg = {} as any; // Minimal mock
  const runtime = { log: vi.fn(), error: vi.fn() } as any;

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

  it("handles select_static with option field", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok3",
      action: {
        value: { field: "model_selection" },
        tag: "select_static",
        option: "gpt-4o",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    const content = JSON.parse(call.event.message.content);
    const parsed = JSON.parse(content.text);
    expect(parsed).toEqual({
      field: "model_selection",
      option: "gpt-4o",
    });
  });

  it("handles multi-select with options array", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: {
        value: { field: "tags" },
        tag: "checkbox",
        options: ["bug", "feature", "docs"],
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    const content = JSON.parse(call.event.message.content);
    const parsed = JSON.parse(content.text);
    expect(parsed).toEqual({
      field: "tags",
      options: ["bug", "feature", "docs"],
    });
  });

  it("handles form submission with form_value", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok5",
      action: {
        value: { form_id: "feedback_form" },
        tag: "form",
        form_value: { name: "Alice", rating: "5" },
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi.mocked(handleFeishuMessage).mock.calls.at(-1)![0];
    const content = JSON.parse(call.event.message.content);
    const parsed = JSON.parse(content.text);
    expect(parsed).toEqual({
      form_id: "feedback_form",
      form_value: { name: "Alice", rating: "5" },
    });
  });

  it("preserves existing button behavior with value.command", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok6",
      action: { value: { command: "/help" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/help"}',
          }),
        }),
      }),
    );
  });
});
