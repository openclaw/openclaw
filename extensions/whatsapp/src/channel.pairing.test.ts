// Whatsapp tests cover channel pairing approval notifications.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "jid" })),
  sendTypingWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
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

  it("declares approval notifications for outbound gateway delivery", () => {
    expect(whatsappPlugin.pairing?.notifyApproval).toEqual(expect.any(Function));
    expect(whatsappPlugin.pairing).not.toHaveProperty("approvalMessage");
    expect(whatsappPlugin.pairing).not.toHaveProperty("notifyApprovalDelivery");
  });

  it("keeps WhatsApp allowlist normalization on the pairing adapter", () => {
    expect(whatsappPlugin.pairing?.normalizeAllowEntry?.("whatsapp:+1 (555) 010-9999")).toBe(
      "15550109999",
    );
  });
});
