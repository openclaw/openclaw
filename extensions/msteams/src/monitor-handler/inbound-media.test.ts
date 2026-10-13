// Msteams tests cover inbound media plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../attachments.js", () => ({
  downloadMSTeamsAttachments: vi.fn(async () => []),
  downloadMSTeamsGraphMedia: vi.fn(async () => ({ media: [] })),
  downloadMSTeamsBotFrameworkAttachments: vi.fn(async () => ({ media: [], attachmentCount: 0 })),
  buildMSTeamsGraphMessageUrl: vi.fn(
    (params: { conversationType: string; teamAadGroupId?: string }) =>
      params.conversationType.toLowerCase() === "channel" && params.teamAadGroupId === undefined
        ? undefined
        : "https://graph.microsoft.com/v1.0/teams/team-aad-guid/channels/chan/messages/m",
  ),
  extractMSTeamsHtmlAttachmentIds: vi.fn(() => ["att-0", "att-1"]),
  isBotFrameworkPersonalChatId: vi.fn((id: string | null | undefined) => {
    if (typeof id !== "string") {
      return false;
    }
    return id.startsWith("a:") || id.startsWith("8:orgid:");
  }),
}));

import {
  buildMSTeamsGraphMessageUrl,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
} from "../attachments.js";
import {
  mergeMSTeamsMediaFacts,
  resolveMSTeamsInboundMedia,
  resolveMSTeamsInboundMediaBody,
} from "./inbound-media.js";

// Channel context by default: the Graph fallback is a channel/group code path,
// so its trigger tests must run against a channel conversation, not a DM.
const baseParams = {
  maxBytes: 1024 * 1024,
  tokenProvider: { getAccessToken: vi.fn(async () => "token") },
  conversationType: "channel",
  conversationId: "19:channel-thread@thread.tacv2",
  teamAadGroupId: "team-aad-guid",
  activity: {
    id: "msg-1",
    replyToId: undefined,
    channelData: {
      team: { id: "19:team-general@thread.tacv2", aadGroupId: "team-aad-guid" },
      channel: { id: "19:channel-thread@thread.tacv2" },
    },
  },
  log: { debug: vi.fn() },
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

function firstGraphMediaCall() {
  const [call] = vi.mocked(downloadMSTeamsGraphMedia).mock.calls;
  if (!call) {
    throw new Error("expected Graph media download call");
  }
  return call[0];
}

function firstBotFrameworkAttachmentCall() {
  const [call] = vi.mocked(downloadMSTeamsBotFrameworkAttachments).mock.calls;
  if (!call) {
    throw new Error("expected Bot Framework attachment download call");
  }
  return call[0];
}

describe("resolveMSTeamsInboundMedia graph fallback trigger", () => {
  it("adds an unavailable notice from structured media counts", () => {
    expect(
      resolveMSTeamsInboundMediaBody({
        body: "",
        nativeMedia: [{ kind: "document" }],
        materializedMedia: [{ kind: "document" }],
      }),
    ).toBe("[msteams attachment unavailable]");
    expect(
      resolveMSTeamsInboundMediaBody({
        body: "hello",
        nativeMedia: [],
        materializedMedia: [],
      }),
    ).toBe("hello");
  });

  it("replaces aligned facts positionally and retains Graph-discovered failures", () => {
    expect(
      mergeMSTeamsMediaFacts(
        [{ kind: "document" }],
        [
          { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" },
          { kind: "image" },
        ],
      ),
    ).toEqual([
      { path: "/tmp/report.pdf", contentType: "application/pdf", kind: "document" },
      { kind: "image" },
    ]);
  });

  it("keeps an explicitly distinct fallback resource separate", () => {
    expect(
      mergeMSTeamsMediaFacts(
        [{ kind: "document", sourceId: "activity-attachment-1" }],
        [
          {
            path: "/tmp/other.pdf",
            contentType: "application/pdf",
            kind: "document",
            sourceId: "graph-attachment-2",
          },
        ],
        { positionallyAligned: false },
      ),
    ).toEqual([
      { kind: "document", sourceId: "activity-attachment-1" },
      {
        path: "/tmp/other.pdf",
        contentType: "application/pdf",
        kind: "document",
        sourceId: "graph-attachment-2",
      },
    ]);
  });

  it("applies a pathless fallback refinement to an unresolved slot", () => {
    expect(
      mergeMSTeamsMediaFacts(
        [{ kind: "document" }],
        [{ kind: "image", contentType: "image/png", sourceId: "graph-image-1" }],
        { positionallyAligned: false },
      ),
    ).toEqual([{ kind: "image", contentType: "image/png", sourceId: "graph-image-1" }]);
  });

  it("preserves the advertised kind when a pathless fallback has no type evidence", () => {
    expect(
      mergeMSTeamsMediaFacts(
        [{ kind: "image", sourceId: "hosted-image-1" }],
        [{ kind: "document", sourceId: "hosted-image-1" }],
        { positionallyAligned: false },
      ),
    ).toEqual([{ kind: "image", sourceId: "hosted-image-1" }]);
  });

  it("triggers opted-in Graph fallback for text plus a tagless channel file stub", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      htmlSummary,
      attachments: [
        {
          contentType: "Text/HTML; charset=utf-8",
          content: '<div><at id="0">Bot</at></div>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).toHaveBeenCalled();
  });

  it("keeps marker-free Graph fallback disabled by default", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      htmlSummary,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><at id="0">Bot</at> Describe the attached image file</div>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does not widen marker-free fallback to a Graph-compatible personal chat", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      conversationType: "personal",
      conversationId: "19:real-graph-chat@unq.gbl.spaces",
      teamAadGroupId: undefined,
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      htmlSummary,
      attachments: [{ contentType: "text/html", content: "<div>mention only</div>" }],
    });

    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("does NOT trigger Graph fallback when no attachments are text/html", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    // No HTML attachments at all → extractor returns [].
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      graphMediaFallback: true,
      attachments: [
        { contentType: "image/png", contentUrl: "https://example.com/img.png" },
        { contentType: "application/pdf", contentUrl: "https://example.com/doc.pdf" },
      ],
    });

    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("fails closed when a channel AAD group ID could not be resolved", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      teamAadGroupId: undefined,
      attachments: [
        {
          contentType: "text/html",
          content: '<attachment id="att-0"></attachment>',
        },
      ],
    });

    expect(buildMSTeamsGraphMessageUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        teamAadGroupId: undefined,
        channelId: "19:channel-thread@thread.tacv2",
      }),
    );
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("forwards log through to downloadMSTeamsGraphMedia for diagnostics", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce(["att-0"]);
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockResolvedValue({ media: [] });
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      log,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    const call = firstGraphMediaCall();
    // The monitor handler's logger is forwarded so graph.ts can report
    // message fetch failures instead of swallowing them (#51749).
    expect(call?.logger).toBe(log);
    expect(log.debug).toHaveBeenCalledWith("graph media fetch empty", {
      messageUrl: "https://graph.microsoft.com/v1.0/teams/team-aad-guid/channels/chan/messages/m",
      hostedStatus: undefined,
      attachmentStatus: undefined,
      hostedCount: undefined,
      attachmentCount: undefined,
      tokenError: undefined,
      attachmentIdCount: 1,
    });
  });
});

describe("resolveMSTeamsInboundMedia bot framework DM routing", () => {
  const dmParams = {
    ...baseParams,
    conversationType: "personal",
    conversationId: "a:1dRsHCobZ1AxURzY05Dc",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    activity: { id: "msg-1", replyToId: undefined, channelData: {} },
  };

  it("routes 'a:' conversation IDs through the Bot Framework attachment endpoint", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      media: [
        {
          path: "/tmp/report.pdf",
          contentType: "application/pdf",
          kind: "document",
        },
      ],
      attachmentCount: 1,
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();

    const mediaList = await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div>A file <attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalledTimes(1);
    const call = firstBotFrameworkAttachmentCall();
    expect(call?.serviceUrl).toBe(dmParams.serviceUrl);
    expect(call?.attachmentIds).toEqual(["att-0", "att-1"]);
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
    expect(mediaList).toHaveLength(1);
    expect(expectDefined(mediaList[0], "MSTeams inbound media").path).toBe("/tmp/report.pdf");
  });

  it("skips Graph fallback for an 'a:' conversation without an exact Graph chat ID", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockResolvedValue({
      media: [],
      attachmentCount: 1,
    });
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).toHaveBeenCalled();
    expect(buildMSTeamsGraphMessageUrl).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("skips BF DM attachment fetch entirely when HTML has no <attachment> tags", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    // Mention-only HTML (no `<attachment id="...">` tag) → extractor
    // returns []. The fallback skips both the Bot Framework and Graph
    // paths so we do not emit spurious 404 diagnostics (#58617).
    vi.mocked(extractMSTeamsHtmlAttachmentIds).mockReturnValueOnce([]);

    await resolveMSTeamsInboundMedia({
      ...dmParams,
      attachments: [
        {
          contentType: "text/html",
          content: '<div><at id="0">Bot</at> hello</div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    expect(downloadMSTeamsGraphMedia).not.toHaveBeenCalled();
  });

  it("logs when serviceUrl is missing for a BF DM with HTML content", async () => {
    vi.mocked(downloadMSTeamsAttachments).mockResolvedValue([]);
    vi.mocked(downloadMSTeamsBotFrameworkAttachments).mockClear();
    vi.mocked(downloadMSTeamsGraphMedia).mockClear();
    vi.mocked(buildMSTeamsGraphMessageUrl).mockClear();
    const log = { debug: vi.fn() };

    await resolveMSTeamsInboundMedia({
      ...baseParams,
      log,
      conversationType: "personal",
      conversationId: "a:bf-dm-id",
      activity: { id: "msg-1", replyToId: undefined, channelData: {} },
      attachments: [
        {
          contentType: "text/html",
          content: '<div><attachment id="att-0"></attachment></div>',
        },
      ],
    });

    expect(downloadMSTeamsBotFrameworkAttachments).not.toHaveBeenCalled();
    // Graph fallback is also skipped because the ID is 'a:'
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
