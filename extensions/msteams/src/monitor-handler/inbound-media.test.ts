import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const inboundMediaMocks = vi.hoisted(() => ({
  buildMSTeamsGraphMessageUrls: vi.fn(),
  downloadMSTeamsAttachments: vi.fn(),
  downloadMSTeamsGraphMedia: vi.fn(),
}));

vi.mock("../attachments.js", () => ({
  buildMSTeamsGraphMessageUrls: inboundMediaMocks.buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments: inboundMediaMocks.downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia: inboundMediaMocks.downloadMSTeamsGraphMedia,
}));

describe("resolveMSTeamsInboundMedia", () => {
  beforeEach(() => {
    inboundMediaMocks.buildMSTeamsGraphMessageUrls.mockReset();
    inboundMediaMocks.downloadMSTeamsAttachments.mockReset();
    inboundMediaMocks.downloadMSTeamsGraphMedia.mockReset();
  });

  it("forwards conversation tenant to Graph media fallback", async () => {
    inboundMediaMocks.downloadMSTeamsAttachments.mockResolvedValue([]);
    inboundMediaMocks.buildMSTeamsGraphMessageUrls.mockReturnValue([
      "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123",
    ]);
    inboundMediaMocks.downloadMSTeamsGraphMedia.mockResolvedValue({
      media: [
        {
          path: "/tmp/image.png",
          placeholder: "<media:image>",
          contentType: "image/png",
        },
      ],
      hostedCount: 1,
      attachmentCount: 0,
      hostedStatus: 200,
      attachmentStatus: 200,
    });

    const media = await resolveMSTeamsInboundMedia({
      attachments: [{ contentType: "text/html", content: '<img src="x" />' }],
      maxBytes: 1024,
      tokenProvider: {
        getAccessToken: async () => "token",
      },
      conversationType: "channel",
      conversationId: "19:chat@thread.tacv2",
      conversationMessageId: "message-1",
      conversationTenantId: "tenant-42",
      activity: {
        id: "message-1",
        replyToId: undefined,
        channelData: {},
      },
      log: {
        debug: vi.fn(),
      },
    });

    expect(media).toEqual([
      {
        path: "/tmp/image.png",
        placeholder: "<media:image>",
        contentType: "image/png",
      },
    ]);
    expect(inboundMediaMocks.downloadMSTeamsGraphMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationTenantId: "tenant-42",
      }),
    );
  });
});
