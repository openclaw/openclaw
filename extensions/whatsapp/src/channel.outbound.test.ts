import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppPollFixture,
  expectWhatsAppPollSent,
} from "../../../src/test-helpers/whatsapp-outbound.js";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "wa-poll-1", toJid: "1555@s.whatsapp.net" })),
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      whatsapp: {
        sendPollWhatsApp: hoisted.sendPollWhatsApp,
      },
    },
  }),
}));

import { whatsappPlugin } from "./channel.js";

describe("whatsappPlugin outbound sendPoll", () => {
  it("threads cfg into runtime sendPollWhatsApp call", async () => {
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await whatsappPlugin.outbound!.sendPoll!({
      cfg,
      to,
      poll,
      accountId,
    });

    expectWhatsAppPollSent(hoisted.sendPollWhatsApp, { cfg, poll, to, accountId });
    expect(result).toEqual({ messageId: "wa-poll-1", toJid: "1555@s.whatsapp.net" });
  });
});
