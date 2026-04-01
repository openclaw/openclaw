import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadMSTeamsAttachments: vi.fn(),
  buildMSTeamsGraphMessageUrls: vi.fn(),
  downloadMSTeamsGraphMedia: vi.fn(),
}));

vi.mock("../attachments.js", () => ({
  downloadMSTeamsAttachments: mocks.downloadMSTeamsAttachments,
  buildMSTeamsGraphMessageUrls: mocks.buildMSTeamsGraphMessageUrls,
  downloadMSTeamsGraphMedia: mocks.downloadMSTeamsGraphMedia,
}));

import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const baseParams = {
  maxBytes: 10_000_000,
  tokenProvider: { getAccessToken: async () => "token" },
  conversationType: "channel",
  conversationId: "19:abc@thread.tacv2",
  activity: {
    id: "1712345678901",
    replyToId: "1712345000000",
    channelData: { team: { id: "team1" }, channel: { id: "chan1" } },
  },
  log: { debug: vi.fn() },
};

describe("resolveMSTeamsInboundMedia", () => {
  beforeEach(() => {
    mocks.downloadMSTeamsAttachments.mockReset();
    mocks.buildMSTeamsGraphMessageUrls.mockReset();
    mocks.downloadMSTeamsGraphMedia.mockReset();
  });

  it("triggers Graph API fallback for mixed attachment types when direct download returns nothing", async () => {
    // Simulate a thread reply with a text/html quote + file.download.info without downloadUrl.
    // Direct download returns nothing because downloadUrl is missing.
    mocks.downloadMSTeamsAttachments.mockResolvedValue([]);
    mocks.buildMSTeamsGraphMessageUrls.mockReturnValue([
      "https://graph.microsoft.com/v1.0/teams/team1/channels/chan1/messages/1712345000000/replies/1712345678901",
    ]);
    mocks.downloadMSTeamsGraphMedia.mockResolvedValue({
      media: [{ filePath: "/tmp/file.pdf", contentType: "application/pdf" }],
      hostedCount: 0,
      attachmentCount: 1,
    });

    const result = await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { contentType: "text/html", content: "<blockquote>quoted reply</blockquote>" },
        {
          contentType: "application/vnd.microsoft.teams.file.download.info",
          content: { uniqueId: "abc123", fileType: "pdf" },
          // No downloadUrl — this is the thread reply behavior
        },
      ],
    });

    expect(mocks.buildMSTeamsGraphMessageUrls).toHaveBeenCalled();
    expect(mocks.downloadMSTeamsGraphMedia).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.contentType).toBe("application/pdf");
  });

  it("triggers Graph API fallback for text/html-only attachments (existing behavior)", async () => {
    mocks.downloadMSTeamsAttachments.mockResolvedValue([]);
    mocks.buildMSTeamsGraphMessageUrls.mockReturnValue([
      "https://graph.microsoft.com/v1.0/teams/team1/channels/chan1/messages/1712345678901",
    ]);
    mocks.downloadMSTeamsGraphMedia.mockResolvedValue({
      media: [{ filePath: "/tmp/img.png", contentType: "image/png" }],
      hostedCount: 1,
      attachmentCount: 0,
    });

    const result = await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [{ contentType: "text/html", content: "<img src='...' />" }],
    });

    expect(mocks.buildMSTeamsGraphMessageUrls).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("does not trigger Graph fallback when direct download succeeds", async () => {
    mocks.downloadMSTeamsAttachments.mockResolvedValue([
      { filePath: "/tmp/doc.pdf", contentType: "application/pdf" },
    ]);

    const result = await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.file.download.info",
          content: {
            downloadUrl: "https://example.com/file.pdf",
            uniqueId: "abc",
            fileType: "pdf",
          },
        },
      ],
    });

    expect(mocks.buildMSTeamsGraphMessageUrls).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("does not trigger Graph fallback when there are no attachments", async () => {
    mocks.downloadMSTeamsAttachments.mockResolvedValue([]);

    const result = await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [],
    });

    expect(mocks.buildMSTeamsGraphMessageUrls).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });
});
