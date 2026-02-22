import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  getChatChannelMeta: () => ({ id: "whatsapp", label: "WhatsApp" }),
  normalizeWhatsAppTarget: vi.fn(),
  resolveWhatsAppOutboundTarget: vi.fn(),
  WhatsAppConfigSchema: {},
  whatsappOnboardingAdapter: {},
  resolveWhatsAppHeartbeatRecipients: vi.fn(),
  buildChannelConfigSchema: vi.fn(),
  collectWhatsAppStatusIssues: vi.fn(),
  createActionGate: vi.fn(),
  DEFAULT_ACCOUNT_ID: "default",
  escapeRegExp: vi.fn(),
  formatPairingApproveHint: vi.fn(),
  isWhatsAppGroupJid: vi.fn(),
  listWhatsAppAccountIds: vi.fn(),
  listWhatsAppDirectoryGroupsFromConfig: vi.fn(),
  listWhatsAppDirectoryPeersFromConfig: vi.fn(),
  looksLikeWhatsAppTargetId: vi.fn(),
  migrateBaseNameToDefaultAccount: vi.fn(),
  normalizeAccountId: vi.fn(),
  normalizeE164: vi.fn(),
  normalizeWhatsAppMessagingTarget: vi.fn(),
  readStringParam: vi.fn(),
  resolveDefaultWhatsAppAccountId: vi.fn(),
  resolveWhatsAppAccount: vi.fn(),
  resolveWhatsAppGroupRequireMention: vi.fn(),
  resolveWhatsAppGroupToolPolicy: vi.fn(),
  applyAccountNameToChannelSection: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: vi.fn(() => ({
    channel: {
      text: { chunkText: vi.fn() },
      whatsapp: {
        sendMessageWhatsApp: vi.fn(),
        createLoginTool: vi.fn(),
      },
    },
  })),
}));

import { whatsappPlugin } from "./channel.js";

const cfg = {};

describe("whatsappPlugin outbound", () => {
  it("forwards mediaLocalRoots on sendMedia adapter path", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = whatsappPlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "5511999999999@s.whatsapp.net",
      text: "caption",
      mediaUrl: "file:///workspace/image.png",
      mediaLocalRoots: ["/workspace"],
      accountId: "default",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "5511999999999@s.whatsapp.net",
      "caption",
      expect.objectContaining({
        mediaUrl: "file:///workspace/image.png",
        mediaLocalRoots: ["/workspace"],
        accountId: "default",
      }),
    );
    expect(result).toEqual({ channel: "whatsapp", messageId: "m-media" });
  });

  it("does not pass mediaLocalRoots when not provided", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m-media-2" });
    const sendMedia = whatsappPlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();

    await sendMedia!({
      cfg,
      to: "5511999999999@s.whatsapp.net",
      text: "caption",
      mediaUrl: "https://example.com/pic.png",
      accountId: "default",
      deps: { sendWhatsApp },
    });

    const callOptions = sendWhatsApp.mock.calls[0][2];
    expect(callOptions.mediaLocalRoots).toBeUndefined();
  });
});
