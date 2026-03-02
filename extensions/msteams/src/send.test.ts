import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageMSTeams } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  requiresFileConsent: vi.fn(),
  prepareFileConsentActivity: vi.fn(),
  extractFilename: vi.fn(async () => "fallback.bin"),
  sendMSTeamsMessages: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./file-consent-helpers.js", () => ({
  requiresFileConsent: mockState.requiresFileConsent,
  prepareFileConsentActivity: mockState.prepareFileConsentActivity,
}));

vi.mock("./media-helpers.js", () => ({
  extractFilename: mockState.extractFilename,
  extractMessageId: () => "message-1",
}));

vi.mock("./messenger.js", () => ({
  sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  buildConversationReference: () => ({}),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
    },
  }),
}));

describe("sendMessageMSTeams", () => {
  beforeEach(() => {
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.requiresFileConsent.mockReset();
    mockState.prepareFileConsentActivity.mockReset();
    mockState.extractFilename.mockReset();
    mockState.sendMSTeamsMessages.mockReset();

    mockState.extractFilename.mockResolvedValue("fallback.bin");
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {},
      appId: "app-id",
      conversationId: "19:conversation@thread.tacv2",
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "personal",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024,
      sharePointSiteId: undefined,
    });
    mockState.sendMSTeamsMessages.mockResolvedValue(["message-1"]);
  });

  it("loads media through shared helper and forwards mediaLocalRoots", async () => {
    const mediaBuffer = Buffer.from("tiny-image");
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: mediaBuffer,
      contentType: "image/png",
      fileName: "inline.png",
      kind: "image",
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:conversation@thread.tacv2",
      text: "hello",
      mediaUrl: "file:///tmp/agent-workspace/inline.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/inline.png",
      {
        maxBytes: 8 * 1024,
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );

    expect(mockState.sendMSTeamsMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            text: "hello",
            mediaUrl: `data:image/png;base64,${mediaBuffer.toString("base64")}`,
          }),
        ],
      }),
    );
  });
});
