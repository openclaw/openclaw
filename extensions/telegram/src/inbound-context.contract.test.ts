// Telegram tests cover inbound context.contract plugin behavior.
import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("Telegram inbound context contract", () => {
  it("keeps inbound context finalized", async () => {
    const context = await buildTelegramMessageContextForTest({
      cfg: {
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      } satisfies OpenClawConfig,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1_736_380_800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
    });

    const payload = context?.ctxPayload;
    if (!payload) {
      throw new Error("expected telegram inbound payload");
    }
    expectChannelInboundContextContract(payload);
  });

  it("keeps ordinary reply facts separate from the current agent body", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "answer this",
        date: 1_736_380_800,
        message_id: 2,
        from: { id: 99, first_name: "Ada" },
        reply_to_message: {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "previous question",
          date: 1_736_380_700,
          message_id: 1,
          from: { id: 98, first_name: "Grace" },
        },
      },
    });

    const payload = context?.ctxPayload;
    if (!payload) {
      throw new Error("expected telegram inbound payload");
    }
    expectChannelInboundContextContract(payload);
    expect(payload.BodyForAgent).toBe("answer this");
    expect(payload.ReplyToId).toBe("1");
    expect(payload.ReplyToBody).toBe("previous question");
    expect(payload.ReplyToSender).toBe("Grace");
    expect(payload.ReplyToIsQuote).toBeUndefined();
  });

  it("preserves selected quote facts without promoting quoted text into the agent body", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "answer the selected clause",
        date: 1_736_380_800,
        message_id: 2,
        from: { id: 99, first_name: "Ada" },
        reply_to_message: {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "the complete earlier message",
          date: 1_736_380_700,
          message_id: 1,
          from: { id: 98, first_name: "Grace" },
        },
        quote: {
          text: " selected clause\n",
          position: 4,
          entities: [{ type: "bold", offset: 1, length: 8 }],
        },
      },
    });

    const payload = context?.ctxPayload;
    if (!payload) {
      throw new Error("expected telegram inbound payload");
    }
    expectChannelInboundContextContract(payload);
    expect(payload.BodyForAgent).toBe("answer the selected clause");
    expect(payload.ReplyToId).toBe("1");
    expect(payload.ReplyToBody).toBe("selected clause");
    expect(payload.ReplyToSender).toBe("Grace");
    expect(payload.ReplyToIsQuote).toBe(true);
    expect(payload.ReplyToQuoteText).toBe(" selected clause\n");
    expect(payload.ReplyToQuotePosition).toBe(4);
    expect(payload.ReplyToQuoteSourceText).toBe("the complete earlier message");
  });
});
