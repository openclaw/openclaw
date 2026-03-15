import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" })),
}));

vi.mock("../../../src/globals.js", () => ({
  shouldLogVerbose: () => false,
}));

vi.mock("./send.js", () => ({
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

import { whatsappOutbound } from "./outbound-adapter.js";

describe("whatsappOutbound sendPoll", () => {
  it("threads cfg through poll send options", async () => {
    const cfg = { marker: "resolved-cfg" } as OpenClawConfig;
    const poll = {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    };

    const result = await whatsappOutbound.sendPoll!({
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
    expect(result).toEqual({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" });
  });
});
