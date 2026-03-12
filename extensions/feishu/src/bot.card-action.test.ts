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

  it("handles card action with input_value", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u1", user_id: "uid1", union_id: "un1" },
      token: "tok3",
      action: { value: {}, tag: "input", input_value: "hello", name: "q1" },
      context: { open_id: "u1", user_id: "uid1", chat_id: "chat1" },
    };
    await handleFeishuCardAction({ cfg, event, runtime });
    const parsed = JSON.parse(
      JSON.parse(
        (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0].event.message
          .content,
      ).text,
    );
    expect(parsed).toMatchObject({ action: "input", input_value: "hello", name: "q1" });
  });

  it("handles card action with form_value", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u1", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: {
        value: {},
        tag: "form",
        form_value: { field1: "val1", field2: "val2" },
        name: "myform",
      },
      context: { open_id: "u1", user_id: "uid1", chat_id: "chat1" },
    };
    await handleFeishuCardAction({ cfg, event, runtime });
    const parsed = JSON.parse(
      JSON.parse(
        (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0].event.message
          .content,
      ).text,
    );
    expect(parsed).toMatchObject({
      action: "form",
      form_value: { field1: "val1", field2: "val2" },
      name: "myform",
    });
  });

  it("handles card action with option (select)", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u1", user_id: "uid1", union_id: "un1" },
      token: "tok5",
      action: { value: {}, tag: "select_static", option: "opt_a", name: "dropdown1" },
      context: { open_id: "u1", user_id: "uid1", chat_id: "chat1" },
    };
    await handleFeishuCardAction({ cfg, event, runtime });
    const parsed = JSON.parse(
      JSON.parse(
        (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0].event.message
          .content,
      ).text,
    );
    expect(parsed).toMatchObject({ action: "select_static", option: "opt_a", name: "dropdown1" });
  });

  it("handles card action with name-only (triggers form branch)", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u1", user_id: "uid1", union_id: "un1" },
      token: "tok6",
      action: { value: { key: "val" }, tag: "button", name: "btn1" },
      context: { open_id: "u1", user_id: "uid1", chat_id: "chat1" },
    };
    await handleFeishuCardAction({ cfg, event, runtime });
    const parsed = JSON.parse(
      JSON.parse(
        (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0].event.message
          .content,
      ).text,
    );
    expect(parsed).toMatchObject({ action: "button", name: "btn1", value: { key: "val" } });
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
});
