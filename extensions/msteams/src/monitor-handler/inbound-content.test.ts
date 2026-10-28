import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../attachments/download.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/download.js")>()),
  downloadMSTeamsAttachments: vi.fn(async () => []),
}));
vi.mock("../attachments/graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/graph.js")>()),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
}));
vi.mock("../attachments/bot-framework.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments/bot-framework.js")>()),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ media: [], attachmentCount: 0 })),
}));

import { downloadMSTeamsBotFrameworkAttachments } from "../attachments/bot-framework.js";
import { downloadMSTeamsAttachments } from "../attachments/download.js";
import { downloadMSTeamsGraphMedia } from "../attachments/graph.js";
import type { MSTeamsAttachmentLike, MSTeamsInboundMedia } from "../attachments/types.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";
import { createTurnContext } from "./message-handler.test-support.js";

const direct = vi.mocked(downloadMSTeamsAttachments);
const graph = vi.mocked(downloadMSTeamsGraphMedia);
const botFramework = vi.mocked(downloadMSTeamsBotFrameworkAttachments);
const html = (content: string, contentType = "text/html") => [{ contentType, content }];
const markedHtml = html(
  '<div><attachment id="att-0"></attachment><attachment id="att-1"></attachment></div>',
);
const htmlSummary = {
  htmlAttachments: 1,
  imgTags: 0,
  dataImages: 0,
  cidImages: 0,
  srcHosts: [],
  attachmentIds: [],
};
const pdf = { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" } as const;
const bfUrl = "https://smba.trafficmanager.net/amer/";
const personalChat = { conversationType: "personal", conversationId: "a:bf-dm-id" };
type ContentParams = Parameters<typeof prepareMSTeamsInboundContent>[0];
type ContentOptions = Partial<
  Omit<ContentParams, "entry" | "resolveTeamAadGroupId" | "mediaMaxBytes" | "tokenProvider" | "log">
> & { attachments?: MSTeamsAttachmentLike[]; serviceUrl?: string };

function prepare({ attachments = markedHtml, serviceUrl, ...options }: ContentOptions = {}) {
  return prepareMSTeamsInboundContent({
    entry: {
      context: createTurnContext({
        type: "message",
        id: "msg-1",
        serviceUrl,
        channelData: { channel: { id: "19:channel-thread@thread.tacv2" } },
      }),
      rawText: options.rawBody ?? "hello",
      text: options.rawBody ?? "hello",
      attachments,
      wasMentioned: false,
      implicitMentionKinds: [],
      turnAdoptionLifecycle: undefined,
    },
    rawBody: "hello",
    advertisedMedia: [],
    conversationType: "channel",
    conversationId: "19:channel-thread@thread.tacv2",
    ...options,
    resolveTeamAadGroupId: async () => options.teamAadGroupId,
    mediaMaxBytes: 1024 * 1024,
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  });
}

describe("Teams inbound content", () => {
  beforeEach(() => {
    direct.mockReset().mockResolvedValue([]);
    graph.mockReset().mockResolvedValue({ media: [] });
    botFramework.mockReset().mockResolvedValue({ media: [] });
  });

  it("reports advertised unavailable attachments", async () => {
    expect(await prepare({ rawBody: "", advertisedMedia: [{ kind: "document" }] })).toEqual({
      agentBody: "[msteams attachment unavailable]",
      inboundMedia: [{ kind: "document" }],
    });
  });

  it("replaces aligned direct facts and retains additional unavailable media", async () => {
    direct.mockResolvedValue([pdf, { kind: "image" }]);
    expect(await prepare({ advertisedMedia: [{ kind: "document" }] })).toEqual({
      agentBody: "hello\n\n[msteams attachment unavailable]",
      inboundMedia: [pdf, { kind: "image" }],
    });
    expect(graph).not.toHaveBeenCalled();
  });

  const nativeFile = { kind: "document", sourceId: "activity-1" } as const;
  const graphFile = { ...pdf, path: "/tmp/other.pdf", sourceId: "graph-2" };
  const typedImage = { kind: "image", contentType: "image/png", sourceId: "image-1" } as const;
  const nativeImage = { kind: "image", sourceId: "image-1" } as const;
  it.each<[MSTeamsInboundMedia, MSTeamsInboundMedia, MSTeamsInboundMedia[]]>([
    [nativeFile, graphFile, [nativeFile, graphFile]],
    [{ kind: "document" }, typedImage, [typedImage]],
    [nativeImage, { kind: "document", sourceId: "image-1" }, [nativeImage]],
  ])("merges Graph facts: %j + %j", async (native, recovered, expected) => {
    direct.mockResolvedValue([native]);
    graph.mockResolvedValue({ media: [recovered] });
    expect(await prepare({ advertisedMedia: [native], teamAadGroupId: "team-aad-guid" })).toEqual({
      agentBody: "hello\n\n[msteams attachment unavailable]",
      inboundMedia: expected,
    });
  });

  it.each([
    { graphMediaFallback: true, conversationType: "channel", recover: true },
    { graphMediaFallback: true, conversationType: "groupchat", recover: true },
    { graphMediaFallback: undefined, conversationType: "channel", recover: false },
    { graphMediaFallback: true, conversationType: "personal", recover: false },
  ])("gates marker-free recovery ($conversationType)", async ({ recover, ...options }) => {
    graph.mockResolvedValue({ media: [pdf] });
    const result = await prepare({
      ...options,
      attachments: html("<div><at>Bot</at></div>", "Text/HTML; charset=utf-8"),
      htmlSummary,
      teamAadGroupId: "team-aad-guid",
    });
    expect(graph).toHaveBeenCalledTimes(recover ? 1 : 0);
    expect(result?.inboundMedia).toEqual(recover ? [pdf] : []);
  });

  it.each<[string, ContentOptions, number]>([
    ["empty Bot Framework result", { ...personalChat, serviceUrl: bfUrl }, 1],
    ["mention-only personal HTML", { ...personalChat, attachments: html("<at>Bot</at> hello") }, 0],
    [
      "non-HTML attachment",
      {
        graphMediaFallback: true,
        attachments: [{ contentType: "image/png", contentUrl: "https://example.com/img.png" }],
      },
      0,
    ],
  ])("does not switch %s to Graph", async (_name, options, downloads) => {
    expect(await prepare(options)).toEqual({ agentBody: "hello", inboundMedia: [] });
    expect(botFramework).toHaveBeenCalledTimes(downloads);
    expect(graph).not.toHaveBeenCalled();
  });

  it("recovers an orgid Bot Framework ID", async () => {
    botFramework.mockResolvedValue({ media: [pdf], attachmentCount: 1 });
    const result = await prepare({
      ...personalChat,
      conversationId: "8:orgid:bf-dm-id",
      serviceUrl: bfUrl,
    });
    expect(botFramework).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serviceUrl: bfUrl, attachmentIds: ["att-0", "att-1"] }),
    );
    expect(graph).not.toHaveBeenCalled();
    expect(result?.inboundMedia).toEqual([pdf]);
  });

  it("does not recover missing service URLs through another identifier space", async () => {
    await prepare(personalChat);
    expect(botFramework).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });
});
