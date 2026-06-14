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

  it("includes the configured Telegram sender group for admitted DMs", async () => {
    const context = await buildTelegramMessageContextForTest({
      allowFrom: [{ number: "42", group: "friends" }],
      message: {
        chat: { id: 42, type: "private" },
        text: "hello",
        date: 1_736_380_800,
        message_id: 2,
        from: {
          id: 42,
          first_name: "Ada",
          username: "ada",
        },
      },
    });

    expect(context?.ctxPayload?.SenderGroup).toBe("friends");
  });
});
