import { describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  buildMSTeamsGraphMessageUrls: vi.fn(() => [
    "https://graph.microsoft.com/v1.0/chats/c/messages/m",
  ]),
}));

import {
  downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia,
  buildMSTeamsGraphMessageUrls,
} from "../attachments.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const baseParams = {
  maxBytes: 1024 * 1024,
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  conversationType: "personal",
  conversationId: "19:user_bot@unq.gbl.spaces",
  activity: { id: "msg-1", replyToId: undefined, channelData: {} },
  log: { debug: vi.fn() },
};

describe("resolveMSTeamsInboundMedia graph fallback trigger", () => {
  it("triggers Graph fallback when some attachments are text/html (some() behavior)", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
      media: [{ path: "/tmp/img.png", contentType: "image/png", placeholder: "[image]" }],
    });

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { contentType: "text/html", content: "<div><img src='x'/></div>" },
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
      ],
    });

    expect(buildMSTeamsGraphMessageUrls).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when no attachments are text/html", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrls).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
        { contentType: "application/pdf", contentUrl: "https://example.com/doc.pdf" },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when direct download succeeds", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([
      { path: "/tmp/img.png", contentType: "image/png", placeholder: "[image]" },
    ]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      attachments: [{ contentType: "text/html", content: "<div><img src='x'/></div>" }],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });
});
