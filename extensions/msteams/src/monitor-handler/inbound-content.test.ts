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

function setup({ attachments = markedHtml, serviceUrl, ...options }: ContentOptions = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const resolveTeamAadGroupId = vi.fn(async () => options.teamAadGroupId);
  const run = () =>
    prepareMSTeamsInboundContent({
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
      resolveTeamAadGroupId,
      mediaMaxBytes: 1024 * 1024,
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      log,
    });
  return { run, log, resolveTeamAadGroupId };
}

function personal(options: Parameters<typeof setup>[0] = {}) {
  return setup({ ...personalChat, ...options });
}

describe("Teams inbound content", () => {
  beforeEach(() => {
    direct.mockReset().mockResolvedValue([]);
    graph.mockReset().mockResolvedValue({ media: [] });
    botFramework.mockReset().mockResolvedValue({ media: [] });
  });

  it("reports advertised unavailable attachments and preserves ordinary text", async () => {
    expect(await setup({ rawBody: "", advertisedMedia: [{ kind: "document" }] }).run()).toEqual({
      agentBody: "[msteams attachment unavailable]",
      inboundMedia: [{ kind: "document" }],
    });
    expect(await setup({ attachments: [] }).run()).toEqual({
      agentBody: "hello",
      inboundMedia: [],
    });
  });

  it("replaces aligned direct facts and retains additional unavailable media", async () => {
    direct.mockResolvedValue([pdf, { kind: "image" }]);
    expect(await setup({ advertisedMedia: [{ kind: "document" }] }).run()).toEqual({
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
    expect(
      await setup({ advertisedMedia: [native], teamAadGroupId: "team-aad-guid" }).run(),
    ).toEqual({
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
    const result = await setup({
      ...options,
      attachments: html("<div><at>Bot</at></div>", "Text/HTML; charset=utf-8"),
      htmlSummary,
      teamAadGroupId: "team-aad-guid",
    }).run();
    expect(graph).toHaveBeenCalledTimes(recover ? 1 : 0);
    expect(result?.inboundMedia).toEqual(recover ? [pdf] : []);
  });

  it.each<[string, ContentOptions, number, number]>([
    ["unresolved channel", {}, 1, 0],
    ["empty Bot Framework result", { ...personalChat, serviceUrl: bfUrl }, 0, 1],
    [
      "mention-only personal HTML",
      { ...personalChat, attachments: html("<at>Bot</at> hello") },
      0,
      0,
    ],
    [
      "non-HTML attachment",
      {
        graphMediaFallback: true,
        attachments: [{ contentType: "image/png", contentUrl: "https://example.com/img.png" }],
      },
      0,
      0,
    ],
  ])("does not switch %s to Graph", async (_name, options, resolutions, downloads) => {
    const { run, resolveTeamAadGroupId } = setup(options);
    expect(await run()).toEqual({ agentBody: "hello", inboundMedia: [] });
    expect(resolveTeamAadGroupId).toHaveBeenCalledTimes(resolutions);
    expect(botFramework).toHaveBeenCalledTimes(downloads);
    expect(graph).not.toHaveBeenCalled();
  });

  it("forwards the download logger and reports content-free Graph diagnostics", async () => {
    const { run, log } = setup({ teamAadGroupId: "team-aad-guid" });
    await run();
    expect(graph).toHaveBeenCalledWith(expect.objectContaining({ logger: log }));
    expect(log.debug).toHaveBeenCalledWith("graph media fetch empty", {
      messageUrl:
        "https://graph.microsoft.com/v1.0/teams/team-aad-guid/channels/19%3Achannel-thread%40thread.tacv2/messages/msg-1",
      hostedStatus: undefined,
      attachmentStatus: undefined,
      hostedCount: undefined,
      attachmentCount: undefined,
      tokenError: undefined,
      attachmentIdCount: 2,
    });
  });

  it.each(["a:bf-dm-id", "8:orgid:bf-dm-id"])(
    "recovers raw Bot Framework ID %s",
    async (conversationId) => {
      botFramework.mockResolvedValue({ media: [pdf], attachmentCount: 1 });
      const result = await personal({ conversationId, serviceUrl: bfUrl }).run();
      expect(botFramework).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ serviceUrl: bfUrl, attachmentIds: ["att-0", "att-1"] }),
      );
      expect(graph).not.toHaveBeenCalled();
      expect(result?.inboundMedia).toEqual([pdf]);
    },
  );

  it("logs missing service URLs without trying another identifier space", async () => {
    const { run, log } = personal();
    await run();
    expect(botFramework).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "bot framework attachment skipped (missing serviceUrl)",
      personalChat,
    );
  });
});
