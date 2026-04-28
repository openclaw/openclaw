import { describe, expect, it } from "vitest";
import {
  buildFeishuCardActionTextFallback,
  createFeishuCardInteractionEnvelope,
  decodeFeishuCardAction,
} from "./card-interaction.js";

describe("feishu card interaction decoder", () => {
  it("decodes valid structured payloads", () => {
    const result = decodeFeishuCardAction({
      now: 1_700_000_000_000,
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: {
          value: createFeishuCardInteractionEnvelope({
            k: "quick",
            a: "feishu.quick_actions.help",
            q: "/help",
            c: { u: "u123", h: "chat1", t: "group", e: 1_700_000_060_000 },
          }),
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "structured",
        envelope: expect.objectContaining({
          q: "/help",
        }),
      }),
    );
  });

  it("falls back for legacy text-like payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: { value: { text: "/ping" } },
      },
    });

    expect(result).toEqual({ kind: "legacy", text: "/ping" });
    expect(
      buildFeishuCardActionTextFallback({
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: { value: { command: "/new" } },
      }),
    ).toBe("/new");
  });

  it("includes form_value in structured result", () => {
    const result = decodeFeishuCardAction({
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: {
          value: createFeishuCardInteractionEnvelope({
            k: "quick",
            a: "feishu.quick_actions.help",
            q: "/help",
          }),
          form_value: { Input_xxx: "user input", Select_yyy: "option1" },
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "structured",
        formValue: { Input_xxx: "user input", Select_yyy: "option1" },
      }),
    );
  });

  it("appends form_value to legacy text fallback", () => {
    const text = buildFeishuCardActionTextFallback({
      operator: { open_id: "u123" },
      context: { chat_id: "chat1" },
      action: {
        value: { text: "/command" },
        form_value: { Input_xxx: "user input" },
      },
    });

    expect(text).toBe("/command Input_xxx=user input");
  });

  it("handles form_value without value", () => {
    const text = buildFeishuCardActionTextFallback({
      operator: { open_id: "u123" },
      context: { chat_id: "chat1" },
      action: {
        value: {},
        form_value: { Input_xxx: "user input" },
      },
    });

    expect(text).toBe("{} Input_xxx=user input");
  });

  it("rejects malformed structured payloads", () => {
    const result = decodeFeishuCardAction({
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: {
          value: {
            oc: "ocf1",
            k: "quick",
            a: "broken",
            m: { bad: { nested: true } },
          },
        },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("rejects stale payloads", () => {
    const result = decodeFeishuCardAction({
      now: 100,
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: {
          value: createFeishuCardInteractionEnvelope({
            k: "button",
            a: "stale",
            c: { e: 99, t: "group" },
          }),
        },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "stale" });
  });

  it("rejects wrong-conversation payloads when chat context is enforced", () => {
    const result = decodeFeishuCardAction({
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat2" },
        action: {
          value: createFeishuCardInteractionEnvelope({
            k: "button",
            a: "scoped",
            c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
          }),
        },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "wrong_conversation" });
  });

  it("rejects malformed chat-type context", () => {
    const result = decodeFeishuCardAction({
      event: {
        operator: { open_id: "u123" },
        context: { chat_id: "chat1" },
        action: {
          value: {
            oc: "ocf1",
            k: "button",
            a: "bad",
            c: { t: "private" },
          },
        },
      },
    });

    expect(result).toEqual({ kind: "invalid", reason: "malformed" });
  });
});
