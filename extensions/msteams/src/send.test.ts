import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { sendMessageMSTeams } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMSTeamsSendContext: vi.fn(),
  requiresFileConsent: vi.fn(),
  prepareFileConsentActivity: vi.fn(),
  extractFilename: vi.fn(async () => "fallback.bin"),
  sendMSTeamsMessages: vi.fn(),
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  buildTeamsFileInfoCard: vi.fn(),
}));

vi.mock("../runtime-api.js", () => ({
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

vi.mock("./graph-upload.js", () => ({
  uploadAndShareSharePoint: mockState.uploadAndShareSharePoint,
  getDriveItemProperties: mockState.getDriveItemProperties,
  uploadAndShareOneDrive: vi.fn(),
}));

vi.mock("./graph-chat.js", () => ({
  buildTeamsFileInfoCard: mockState.buildTeamsFileInfoCard,
}));

describe("sendMessageMSTeams", () => {
  beforeEach(() => {
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.resolveMSTeamsSendContext.mockReset();
    mockState.requiresFileConsent.mockReset();
    mockState.prepareFileConsentActivity.mockReset();
    mockState.extractFilename.mockReset();
    mockState.sendMSTeamsMessages.mockReset();
    mockState.uploadAndShareSharePoint.mockReset();
    mockState.getDriveItemProperties.mockReset();
    mockState.buildTeamsFileInfoCard.mockReset();

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

  it("uses graphChatId instead of conversationId when uploading to SharePoint", async () => {
    // Simulates a group chat where Bot Framework conversationId is valid but we have
    // a resolved Graph chat ID cached from a prior send.
    const graphChatId = "19:graph-native-chat-id@thread.tacv2";
    const botFrameworkConversationId = "19:bot-framework-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {
        continueConversation: vi.fn(
          async (
            _id: string,
            _ref: unknown,
            fn: (ctx: { sendActivity: () => { id: "msg-1" } }) => Promise<void>,
          ) => fn({ sendActivity: () => ({ id: "msg-1" }) }),
        ),
      },
      appId: "app-id",
      conversationId: botFrameworkConversationId,
      graphChatId,
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "groupChat",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024 * 1024,
      sharePointSiteId: "site-123",
    });

    const pdfBuffer = Buffer.alloc(100, "pdf");
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: pdfBuffer,
      contentType: "application/pdf",
      fileName: "doc.pdf",
      kind: "file",
    });
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.uploadAndShareSharePoint.mockResolvedValue({
      itemId: "item-1",
      webUrl: "https://sp.example.com/doc.pdf",
      shareUrl: "https://sp.example.com/share/doc.pdf",
      name: "doc.pdf",
    });
    mockState.getDriveItemProperties.mockResolvedValue({
      eTag: '"{GUID-123},1"',
      webDavUrl: "https://sp.example.com/dav/doc.pdf",
      name: "doc.pdf",
    });
    mockState.buildTeamsFileInfoCard.mockReturnValue({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sp.example.com/dav/doc.pdf",
      name: "doc.pdf",
      content: { uniqueId: "GUID-123", fileType: "pdf" },
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:bot-framework-id@thread.tacv2",
      text: "here is a file",
      mediaUrl: "https://example.com/doc.pdf",
    });

    // The Graph-native chatId must be passed to SharePoint upload, not the Bot Framework ID
    expect(mockState.uploadAndShareSharePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: graphChatId,
        siteId: "site-123",
      }),
    );
  });

  it("falls back to conversationId when graphChatId is not available", async () => {
    const botFrameworkConversationId = "19:fallback-id@thread.tacv2";

    mockState.resolveMSTeamsSendContext.mockResolvedValue({
      adapter: {
        continueConversation: vi.fn(
          async (
            _id: string,
            _ref: unknown,
            fn: (ctx: { sendActivity: () => { id: "msg-1" } }) => Promise<void>,
          ) => fn({ sendActivity: () => ({ id: "msg-1" }) }),
        ),
      },
      appId: "app-id",
      conversationId: botFrameworkConversationId,
      graphChatId: null, // resolution failed — must fall back
      ref: {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      conversationType: "groupChat",
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      mediaMaxBytes: 8 * 1024 * 1024,
      sharePointSiteId: "site-456",
    });

    const pdfBuffer = Buffer.alloc(50, "pdf");
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: pdfBuffer,
      contentType: "application/pdf",
      fileName: "report.pdf",
      kind: "file",
    });
    mockState.requiresFileConsent.mockReturnValue(false);
    mockState.uploadAndShareSharePoint.mockResolvedValue({
      itemId: "item-2",
      webUrl: "https://sp.example.com/report.pdf",
      shareUrl: "https://sp.example.com/share/report.pdf",
      name: "report.pdf",
    });
    mockState.getDriveItemProperties.mockResolvedValue({
      eTag: '"{GUID-456},1"',
      webDavUrl: "https://sp.example.com/dav/report.pdf",
      name: "report.pdf",
    });
    mockState.buildTeamsFileInfoCard.mockReturnValue({
      contentType: "application/vnd.microsoft.teams.card.file.info",
      contentUrl: "https://sp.example.com/dav/report.pdf",
      name: "report.pdf",
      content: { uniqueId: "GUID-456", fileType: "pdf" },
    });

    await sendMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "conversation:19:fallback-id@thread.tacv2",
      text: "report",
      mediaUrl: "https://example.com/report.pdf",
    });

    // Falls back to conversationId when graphChatId is null
    expect(mockState.uploadAndShareSharePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: botFrameworkConversationId,
        siteId: "site-456",
      }),
    );
  });
});
