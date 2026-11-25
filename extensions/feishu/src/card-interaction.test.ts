import { describe, expect, it, vi } from "vitest";
import { createFeishuCardInteractionEnvelope, decodeFeishuCardAction } from "./card-interaction.js";

const decode = (value: unknown, now?: number, chatId = "chat1") => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(now ?? Date.now());
  return decodeFeishuCardAction({
    operator: { open_id: "u123" },
    context: { chat_id: chatId },
    action: { value },
  });
};

describe("feishu card interaction decoder", () => {
  it("decodes valid structured payloads", () => {
    const result = decode(
      createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.quick_actions.help",
        q: "/help",
        c: { u: "u123", h: "chat1", t: "group", e: 1_700_000_060_000 },
      }),
      1_700_000_000_000,
    );

    expect(result).toEqual({
      kind: "structured",
      envelope: {
        oc: "ocf1",
        k: "quick",
        a: "feishu.quick_actions.help",
        q: "/help",
        c: { u: "u123", h: "chat1", t: "group", e: 1_700_000_060_000 },
      },
    });
  });

  it.each([
    [{ text: "/ping" }, "/ping"],
    [{ command: "/new" }, "/new"],
  ] as const)("falls back for legacy payload %j", (value, text) => {
    expect(decode(value)).toEqual({ kind: "legacy", text });
  });

  it.each([
    { oc: "ocf1", k: "quick", a: "broken", m: { bad: { nested: true } } },
    { oc: "ocf1", k: "button", a: "bad", c: { t: "private" } },
  ])("rejects malformed structured payload %j", (value) => {
    expect(decode(value)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("rejects stale payloads", () => {
    const result = decode(
      createFeishuCardInteractionEnvelope({
        k: "button",
        a: "stale",
        c: { e: 99, t: "group" },
      }),
      100,
    );

    expect(result).toEqual({ kind: "invalid", reason: "stale" });
  });

  it("rejects wrong-conversation payloads when chat context is enforced", () => {
    const result = decode(
      createFeishuCardInteractionEnvelope({
        k: "button",
        a: "scoped",
        c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
      }),
      undefined,
      "chat2",
    );

    expect(result).toEqual({ kind: "invalid", reason: "wrong_conversation" });
  });
});
