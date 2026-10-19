import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments.js")>()),
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ media: [], attachmentCount: 0 })),
}));

import {
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  type MSTeamsAttachmentLike,
  type MSTeamsInboundMedia,
} from "../attachments.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";

const markedHtml = {
  contentType: "text/html",
  content: '<div><attachment id="att-0"></attachment><attachment id="att-1"></attachment></div>',
};
const htmlSummary = {
  htmlAttachments: 1,
  imgTags: 0,
  dataImages: 0,
  cidImages: 0,
  srcHosts: [],
  attachmentTags: 0,
  attachmentIds: [],
};

function setup(
  options: {
    attachments?: MSTeamsAttachmentLike[];
    advertisedMedia?: MSTeamsInboundMedia[];
    rawBody?: string;
    conversationType?: string;
    conversationId?: string;
    teamAadGroupId?: string;
    serviceUrl?: string;
    graphMediaFallback?: boolean;
    htmlSummary?: typeof htmlSummary;
  } = {},
) {
  const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const resolveTeamAadGroupId = vi.fn(async () => options.teamAadGroupId);
  const attachments = options.attachments ?? [markedHtml];
  const run = () =>
    prepareMSTeamsInboundContent({
      entry: {
        context: {
          activity: {
            type: "message",
            id: "msg-1",
            serviceUrl: options.serviceUrl,
            channelData: { channel: { id: "19:channel-thread@thread.tacv2" } },
          },
          sendActivity: vi.fn(async () => undefined),
          sendActivities: vi.fn(async () => []),
          updateActivity: vi.fn(async () => undefined),
          deleteActivity: vi.fn(async () => undefined),
        },
        rawText: options.rawBody ?? "hello",
        text: options.rawBody ?? "hello",
        attachments,
        wasMentioned: false,
        implicitMentionKinds: [],
        turnAdoptionLifecycle: undefined,
      },
      rawBody: options.rawBody ?? "hello",
      advertisedMedia: options.advertisedMedia ?? [],
      htmlSummary: options.htmlSummary,
      conversationType: options.conversationType ?? "channel",
      conversationId: options.conversationId ?? "19:channel-thread@thread.tacv2",
      teamAadGroupId: options.teamAadGroupId,
      resolveTeamAadGroupId,
      mediaMaxBytes: 1024 * 1024,
      tokenProvider: { getAccessToken: vi.fn(async () => "token") },
      graphMediaFallback: options.graphMediaFallback,
      log,
    });
  return { run, log, resolveTeamAadGroupId };
}

describe("Teams inbound content", () => {
  beforeEach(() => {
    vi.mocked(downloadMSTeamsAttachments).mockReset().mockResolvedValue([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockReset().mockResolvedValue({ media: [] });
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockReset().mockResolvedValue({ media: [] });
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
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([
      { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" },
      { kind: "image" },
    ]);
    expect(await setup({ advertisedMedia: [{ kind: "document" }] }).run()).toEqual({
      agentBody: "hello\n\n[msteams attachment unavailable]",
      inboundMedia: [
        { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" },
        { kind: "image" },
      ],
    });
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("keeps an explicitly distinct Graph resource separate from unresolved direct media", async () => {
    const unresolved = { kind: "document", sourceId: "activity-attachment-1" } as const;
    const recovered = {
      path: "/tmp/other.pdf",
      contentType: "application/pdf",
      kind: "document",
      sourceId: "graph-attachment-2",
    } as const;
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([unresolved]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [recovered] });
    expect(
      await setup({ advertisedMedia: [unresolved], teamAadGroupId: "team-aad-guid" }).run(),
    ).toEqual({
      agentBody: "hello\n\n[msteams attachment unavailable]",
      inboundMedia: [unresolved, recovered],
    });
  });

  it("refines an unresolved slot using Graph content-type evidence", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([{ kind: "document" }]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
      media: [{ kind: "image", contentType: "image/png", sourceId: "graph-image-1" }],
    });
    expect(
      (
        await setup({
          advertisedMedia: [{ kind: "document" }],
          teamAadGroupId: "team-aad-guid",
        }).run()
      )?.inboundMedia,
    ).toEqual([{ kind: "image", contentType: "image/png", sourceId: "graph-image-1" }]);
  });

  it("preserves the advertised kind when matching Graph media has no type evidence", async () => {
    const unresolved = { kind: "image", sourceId: "hosted-image-1" } as const;
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([unresolved]);
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
      media: [{ kind: "document", sourceId: "hosted-image-1" }],
    });
    expect(
      (await setup({ advertisedMedia: [unresolved], teamAadGroupId: "team-aad-guid" }).run())
        ?.inboundMedia,
    ).toEqual([unresolved]);
  });

  it.each([
    { graphMediaFallback: true, conversationType: "channel", recover: true },
    { graphMediaFallback: true, conversationType: "groupchat", recover: true },
    { graphMediaFallback: undefined, conversationType: "channel", recover: false },
    { graphMediaFallback: true, conversationType: "personal", recover: false },
  ])(
    "keeps marker-free Graph recovery scoped to opted-in channel/group messages ($conversationType, $graphMediaFallback)",
    async ({ recover, ...options }) => {
      vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({
        media: [{ path: "/tmp/file.pdf", kind: "document" }],
      });
      const result = await setup({
        ...options,
        attachments: [
          { contentType: "Text/HTML; charset=utf-8", content: "<div><at>Bot</at></div>" },
        ],
        htmlSummary,
        teamAadGroupId: "team-aad-guid",
      }).run();
      expect(downloadMSTeamsGraphMedia).toHaveBeenCalledTimes(recover ? 1 : 0);
      expect(result?.inboundMedia).toEqual(
        recover ? [{ path: "/tmp/file.pdf", kind: "document" }] : [],
      );
    },
  );

  it("does not fetch Graph without HTML media markers or stubs", async () => {
    await setup({
      graphMediaFallback: true,
      attachments: [{ contentType: "image/png", contentUrl: "https://example.com/img.png" }],
    }).run();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("fails closed when a channel AAD group ID cannot be resolved", async () => {
    const { run, resolveTeamAadGroupId } = setup();
    expect(await run()).toEqual({ agentBody: "hello", inboundMedia: [] });
    expect(resolveTeamAadGroupId).toHaveBeenCalledTimes(1);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("forwards the download logger and reports content-free Graph diagnostics", async () => {
    const { run, log } = setup({ teamAadGroupId: "team-aad-guid" });
    await run();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalledWith(
      expect.objectContaining({ logger: log }),
    );
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
    "recovers %s via Bot Framework without Graph ID rewriting",
    async (conversationId) => {
      vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
        media: [{ path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" }],
        attachmentCount: 1,
      });
      const result = await setup({
        conversationType: "personal",
        conversationId,
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }).run();
      expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          attachmentIds: ["att-0", "att-1"],
        }),
      );
      expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
      expect(result?.inboundMedia).toEqual([
        { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" },
      ]);
    },
  );

  it("does not switch an empty Bot Framework result to Graph", async () => {
    await setup({
      conversationType: "personal",
      conversationId: "a:bf-dm-id",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    }).run();
    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalledTimes(1);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does not fetch mention-only personal HTML", async () => {
    await setup({
      conversationType: "personal",
      conversationId: "a:bf-dm-id",
      attachments: [{ contentType: "text/html", content: "<div><at>Bot</at> hello</div>" }],
    }).run();
    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("logs missing service URLs without trying another identifier space", async () => {
    const { run, log } = setup({ conversationType: "personal", conversationId: "a:bf-dm-id" });
    await run();
    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "bot framework attachment skipped (missing serviceUrl)",
      {
        conversationType: "personal",
        conversationId: "a:bf-dm-id",
      },
    );
  });
});
