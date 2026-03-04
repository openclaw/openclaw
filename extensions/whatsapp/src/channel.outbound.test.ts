import type { OpenClawConfig } from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, it, vi } from "vitest";

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
    const cfg = { marker: "resolved-cfg" } as OpenClawConfig;
    const poll = {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    };

    const result = await whatsappPlugin.outbound!.sendPoll!({
      cfg,
      to: "+1555",
      poll,
      accountId: "work",
    });

    expect(hoisted.sendPollWhatsApp).toHaveBeenCalledWith("+1555", poll, {
      verbose: false,
      accountId: "work",
      cfg,
    });
    expect(result).toEqual({ messageId: "wa-poll-1", toJid: "1555@s.whatsapp.net" });
  });
});
