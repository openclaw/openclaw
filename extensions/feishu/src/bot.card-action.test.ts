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

  it("handles select_static dropdown with action.option", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok3",
      action: { value: { field: "model_selection" }, tag: "select_static", option: "gpt-4o" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi
      .mocked(handleFeishuMessage)
      .mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { event: { message: { message_id: string } } }).event.message.message_id ===
          "card-action-tok3",
      );
    expect(call).toBeDefined();
    const inner = JSON.parse(
      JSON.parse((call![0] as { event: { message: { content: string } } }).event.message.content)
        .text,
    );
    expect(inner).toMatchObject({ option: "gpt-4o" });
  });

  it("handles multi-select checkbox with action.options", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: { value: { field: "tags" }, tag: "checkbox", options: ["tag1", "tag2"] },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi
      .mocked(handleFeishuMessage)
      .mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { event: { message: { message_id: string } } }).event.message.message_id ===
          "card-action-tok4",
      );
    expect(call).toBeDefined();
    const inner = JSON.parse(
      JSON.parse((call![0] as { event: { message: { content: string } } }).event.message.content)
        .text,
    );
    expect(inner).toMatchObject({ options: ["tag1", "tag2"] });
  });

  it("handles form submission with action.form_value", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok5",
      action: {
        value: { form_id: "approval" },
        tag: "form",
        form_value: { name: "Alice", approved: true },
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    const call = vi
      .mocked(handleFeishuMessage)
      .mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { event: { message: { message_id: string } } }).event.message.message_id ===
          "card-action-tok5",
      );
    expect(call).toBeDefined();
    const inner = JSON.parse(
      JSON.parse((call![0] as { event: { message: { content: string } } }).event.message.content)
        .text,
    );
    expect(inner).toMatchObject({ form_value: { name: "Alice", approved: true } });
  });
});
