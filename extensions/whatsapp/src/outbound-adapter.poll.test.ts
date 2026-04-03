import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" })),
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../../src/globals.js", () => ({
  shouldLogVerbose: () => false,
}));

vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
    ...actual,
    sendPollWhatsApp: hoisted.sendPollWhatsApp,
    sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
  };
});

let whatsappOutbound: typeof import("./outbound-adapter.js").whatsappOutbound;

describe("whatsappOutbound sendPoll", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ whatsappOutbound } = await import("./outbound-adapter.js"));
  });

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
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});
