// Whatsapp tests cover channel pairing approval notifications.
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendTypingWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendTypingWhatsApp: hoisted.sendTypingWhatsApp,
}));

let whatsappPlugin: typeof import("./channel.js").whatsappPlugin;

describe("whatsapp pairing", () => {
  beforeAll(async () => {
    ({ whatsappPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifies the approved sender through the WhatsApp send path", async () => {
    await whatsappPlugin.pairing?.notifyApproval?.({
      cfg: { channels: { whatsapp: { enabled: true } } },
      id: "5511999999999",
      accountId: "work",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "5511999999999",
      PAIRING_APPROVED_MESSAGE,
      {
        verbose: false,
        cfg: { channels: { whatsapp: { enabled: true } } },
        accountId: "work",
      },
    );
  });

  it("keeps WhatsApp allowlist normalization on the pairing adapter", () => {
    expect(whatsappPlugin.pairing?.normalizeAllowEntry?.("whatsapp:+1 (555) 010-9999")).toBe(
      "15550109999",
    );
  });
});
