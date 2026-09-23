import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext multiline command projection", () => {
  const chat = { id: 999, type: "private" as const, first_name: "Alice" };
  const sender = { id: 42, first_name: "Alice", is_bot: false };

  it("preserves later lines of multiline text-directive commands", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat,
        from: sender,
        text: "/think high\nsummarize the thread so far",
        entities: [{ type: "bot_command", offset: 0, length: "/think".length }],
      },
    });

    expect(context?.ctxPayload.CommandBody).toBe("/think high\nsummarize the thread so far");
  });

  it("keeps the raw multiline reset projection for core-side strict normalization", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat,
        from: sender,
        text: "/reset\nextra context",
        entities: [{ type: "bot_command", offset: 0, length: "/reset".length }],
      },
    });

    // The ingress projection preserves the tail verbatim; the reset flatten policy
    // is applied by the core command layer (session-reset-command / commands-context).
    expect(context?.ctxPayload.CommandBody).toBe("/reset\nextra context");
  });

  it("keeps single-line command normalization unchanged", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat,
        from: sender,
        text: "/status",
        entities: [{ type: "bot_command", offset: 0, length: "/status".length }],
      },
    });

    expect(context?.ctxPayload.CommandBody).toBe("/status");
  });
});
