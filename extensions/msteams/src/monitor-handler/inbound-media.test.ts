import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsHtmlAttachmentSummary, MSTeamsInboundMedia } from "../attachments.js";

const {
  buildMSTeamsGraphMessageUrlsMock,
  downloadMSTeamsAttachmentsMock,
  downloadMSTeamsGraphMediaMock,
} = vi.hoisted(() => ({
  buildMSTeamsGraphMessageUrlsMock: vi.fn(),
  downloadMSTeamsAttachmentsMock: vi.fn(),
  downloadMSTeamsGraphMediaMock: vi.fn(),
}));

vi.mock("../attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../attachments.js")>("../attachments.js");
  return {
    ...actual,
    buildMSTeamsGraphMessageUrls: buildMSTeamsGraphMessageUrlsMock,
    downloadMSTeamsAttachments: downloadMSTeamsAttachmentsMock,
    downloadMSTeamsGraphMedia: downloadMSTeamsGraphMediaMock,
  };
});

import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

const TOKEN_PROVIDER = {
  getAccessToken: vi.fn(async () => "token"),
};

const DOWNLOADED_MEDIA: MSTeamsInboundMedia[] = [
  {
    path: "/tmp/report.pdf",
    contentType: "application/pdf",
    placeholder: "<media:document>",
  },
];

function createHtmlSummary(
  overrides: Partial<MSTeamsHtmlAttachmentSummary>,
): MSTeamsHtmlAttachmentSummary {
  return {
    htmlAttachments: 1,
    imgTags: 0,
    dataImages: 0,
    cidImages: 0,
    srcHosts: [],
    attachmentTags: 0,
    attachmentIds: [],
    ...overrides,
  };
}

function buildParams(params: {
  attachments: Array<{ contentType?: string | null; content?: unknown }>;
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
}) {
  return {
    attachments: params.attachments,
    htmlSummary: params.htmlSummary,
    maxBytes: 1024,
    tokenProvider: TOKEN_PROVIDER,
    conversationType: "channel",
    conversationId: "19:thread@thread.tacv2",
    conversationMessageId: "123",
    activity: {
      id: "123",
      replyToId: "root-1",
      channelData: {
        team: { id: "team-1" },
        channel: { id: "channel-1" },
      },
    },
    log: {},
  };
}

describe("resolveMSTeamsInboundMedia", () => {
  beforeEach(() => {
    buildMSTeamsGraphMessageUrlsMock.mockReset();
    downloadMSTeamsAttachmentsMock.mockReset();
    downloadMSTeamsGraphMediaMock.mockReset();
    TOKEN_PROVIDER.getAccessToken.mockClear();

    downloadMSTeamsAttachmentsMock.mockResolvedValue([]);
    buildMSTeamsGraphMessageUrlsMock.mockReturnValue([
      "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/root-1/replies/123",
    ]);
    downloadMSTeamsGraphMediaMock.mockResolvedValue({
      media: DOWNLOADED_MEDIA,
      attachmentStatus: 200,
    });
  });

  it("skips graph fallback for mention-only html attachments", async () => {
    const media = await resolveMSTeamsInboundMedia(
      buildParams({
        attachments: [{ contentType: "text/html", content: "<div><at>Bot</at> hello</div>" }],
        htmlSummary: createHtmlSummary({ attachmentTags: 0 }),
      }),
    );

    expect(media).toEqual([]);
    expect(buildMSTeamsGraphMessageUrlsMock).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMediaMock).not.toHaveBeenCalled();
  });

  it("skips graph fallback for mention-only html attachments when htmlSummary is omitted", async () => {
    const media = await resolveMSTeamsInboundMedia(
      buildParams({
        attachments: [{ contentType: "text/html", content: "<div><at>Bot</at> hello</div>" }],
      }),
    );

    expect(media).toEqual([]);
    expect(buildMSTeamsGraphMessageUrlsMock).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMediaMock).not.toHaveBeenCalled();
  });

  it("uses graph fallback when html attachments include attachment tags", async () => {
    const media = await resolveMSTeamsInboundMedia(
      buildParams({
        attachments: [
          { contentType: "text/html", content: '<div><attachment id="att-1"></attachment></div>' },
        ],
        htmlSummary: createHtmlSummary({ attachmentTags: 1, attachmentIds: ["att-1"] }),
      }),
    );

    expect(buildMSTeamsGraphMessageUrlsMock).toHaveBeenCalledOnce();
    expect(downloadMSTeamsGraphMediaMock).toHaveBeenCalledOnce();
    expect(media).toEqual(DOWNLOADED_MEDIA);
  });

  it("uses graph fallback for cid-hosted html images without attachment tags", async () => {
    const media = await resolveMSTeamsInboundMedia(
      buildParams({
        attachments: [
          { contentType: "text/html", content: '<div><img src="cid:image-1" /></div>' },
        ],
      }),
    );

    expect(buildMSTeamsGraphMessageUrlsMock).toHaveBeenCalledOnce();
    expect(downloadMSTeamsGraphMediaMock).toHaveBeenCalledOnce();
    expect(media).toEqual(DOWNLOADED_MEDIA);
  });
});
