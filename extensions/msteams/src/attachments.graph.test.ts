import { useAttachmentTestTransport } from "./attachments/transport.test-support.js";
const installAttachmentTestTransport = useAttachmentTestTransport();
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  buildMSTeamsGraphMessageUrl,
  downloadMSTeamsGraphMedia as downloadGraphMedia,
} from "./attachments/graph.js";
import {
  extractMSTeamsHtmlAttachmentIds,
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
} from "./attachments/html.js";
import { setMSTeamsRuntime } from "./runtime.js";

const GRAPH_HOST = "graph.microsoft.com";
const SHAREPOINT_HOST = "contoso.sharepoint.com";
const DEFAULT_MESSAGE_URL = `https://${GRAPH_HOST}/v1.0/chats/19%3Achat/messages/123`;
const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = [GRAPH_HOST, SHAREPOINT_HOST];
const DEFAULT_SHARE_REFERENCE_URL = `https://${SHAREPOINT_HOST}/site/file`;
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const PNG_BUFFER = Buffer.from("png");

const saveResponseMediaMock = vi.fn(
  async (
    res: Response,
    options: {
      maxBytes?: number;
      fallbackContentType?: string;
    },
  ) => {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
      throw new Error(`payload exceeds maxBytes ${options.maxBytes}`);
    }
    return {
      id: "saved.png",
      path: "/tmp/saved.png",
      size: Buffer.byteLength(PNG_BUFFER),
      contentType: options.fallbackContentType ?? CONTENT_TYPE_IMAGE_PNG,
    };
  },
);

const runtimeStub = {
  channel: {
    media: {
      saveResponseMedia: saveResponseMediaMock,
    },
  },
} as unknown as PluginRuntime;

type GraphTestOptions = Partial<Parameters<typeof downloadGraphMedia>[0]> & {
  hosted?: [id: string, bytes: string];
  onShareRequest?: (url: string) => Response | Promise<Response>;
  onUnhandled?: (url: string) => Response | Promise<Response> | undefined;
  observe?: (url: string, init?: RequestInit) => void;
};
const createTokenProvider = (token = "token") => ({ getAccessToken: vi.fn(async () => token) });
const resolvePublicHost = async () => ({ address: "93.184.216.34" });
const createBufferResponse = (payload: Buffer | string, contentType: string) =>
  new Response(new Uint8Array(Buffer.isBuffer(payload) ? payload : Buffer.from(payload)), {
    headers: { "content-type": contentType },
  });
const createPdfResponse = (payload: Buffer | string = "pdf") =>
  createBufferResponse(payload, CONTENT_TYPE_APPLICATION_PDF);
const createJsonResponse = (payload: unknown) => new Response(JSON.stringify(payload));
const createRedirectResponse = (location: string) =>
  new Response(null, { status: 302, headers: { location } });
async function download({
  hosted,
  onShareRequest,
  onUnhandled,
  observe,
  ...overrides
}: GraphTestOptions) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveRequestUrl(input);
    observe?.(url, init);
    if (url === DEFAULT_MESSAGE_URL) {
      return createJsonResponse({
        attachments: onShareRequest
          ? [
              {
                id: "ref-1",
                contentType: "reference",
                contentUrl: DEFAULT_SHARE_REFERENCE_URL,
                name: "report.pdf",
              },
            ]
          : [],
      });
    }
    if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
      return createJsonResponse({
        value: hosted ? [{ id: hosted[0], contentType: CONTENT_TYPE_IMAGE_PNG }] : [],
      });
    }
    if (hosted && url === `${DEFAULT_MESSAGE_URL}/hostedContents/${hosted[0]}/$value`) {
      return createBufferResponse(hosted[1], CONTENT_TYPE_IMAGE_PNG);
    }
    if (url.startsWith(GRAPH_SHARES_URL_PREFIX) && onShareRequest) {
      return onShareRequest(url);
    }
    return (await onUnhandled?.(url)) ?? new Response("not found", { status: 404 });
  });
  installAttachmentTestTransport({ fetchFn: fetchMock, resolveFn: resolvePublicHost });
  const media = await downloadGraphMedia({
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: 1024 * 1024,
    ...overrides,
  });
  return { fetchMock, media };
}

describe("msteams graph attachments", () => {
  beforeEach(() => {
    installAttachmentTestTransport({});
    saveResponseMediaMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  it("merges SharePoint reference attachments with hosted content", async () => {
    const { media } = await download({
      hosted: ["hosted-1", "png"],
      onShareRequest: () => createPdfResponse(),
    });
    expect(media.media).toHaveLength(2);
  });

  it("does not forward Authorization for SharePoint redirects outside auth allowlist", async () => {
    const escapedUrl = "https://example.com/collect";
    const seen: Array<{ url: string; auth: string }> = [];
    const { media } = await download({
      tokenProvider: createTokenProvider("top-secret-token"),
      onShareRequest: () => createRedirectResponse(escapedUrl),
      onUnhandled: (url) => (url === escapedUrl ? createPdfResponse() : undefined),
      observe: (url, init) =>
        seen.push({ url, auth: new Headers(init?.headers).get("Authorization") ?? "" }),
      allowHosts: [...DEFAULT_SHAREPOINT_ALLOW_HOSTS, "example.com"],
      authAllowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
    });

    expect(media.media).toHaveLength(1);
    expect(seen).toContainEqual({ url: escapedUrl, auth: "" });
  });

  it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
    const escapedUrl = "https://evil.example/internal.pdf";
    const { fetchMock, media } = await download({
      onShareRequest: () => createRedirectResponse(escapedUrl),
      onUnhandled: (url) =>
        url === escapedUrl ? createPdfResponse("should-not-be-fetched") : undefined,
      allowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
    });

    expect(media.media).toEqual([{ kind: "document", sourceId: "ref-1" }]);
    const calledUrls = fetchMock.mock.calls.map(([input]) => resolveRequestUrl(input));
    expect(calledUrls).not.toContain(escapedUrl);
  });

  it("enforces maxBytes while streaming hosted content", async () => {
    const { media } = await download({ hosted: ["hosted-oversized", "too large"], maxBytes: 4 });

    expect(media.media).toStrictEqual([
      { kind: "image", contentType: "image/png", sourceId: "hosted-oversized" },
    ]);
    expect(saveResponseMediaMock).toHaveBeenCalledTimes(1);
  });
});

const createHtmlAttachment = (content: string) => ({ contentType: "text/html", content });
const channelParams = {
  conversationType: "channel" as const,
  teamAadGroupId: "team-id",
  channelId: "chan-id",
};
const GRAPH_CHANNEL_MESSAGES_ROOT =
  "https://graph.microsoft.com/v1.0/teams/team-id/channels/chan-id/messages";
function expectAdvertised(
  attachments: Parameters<typeof resolveMSTeamsAdvertisedMedia>[0],
  expected: ReturnType<typeof resolveMSTeamsAdvertisedMedia>,
) {
  expect(resolveMSTeamsAdvertisedMedia(attachments)).toEqual(expected);
}

describe("msteams attachment helpers", () => {
  it("keeps the complete recovery ID list separate from the capped diagnostic summary", () => {
    const attachments = [
      createHtmlAttachment('<attachment id=" one "><attachment id="two"><attachment id="three">'),
      createHtmlAttachment(
        '<attachment id="two"><attachment id="four"><attachment id="five"><attachment id="six"><attachment id=" ">',
      ),
    ];
    expect(summarizeMSTeamsHtmlAttachments(attachments)?.attachmentIds).toEqual(
      "one two three four five".split(" "),
    );
    expect(extractMSTeamsHtmlAttachmentIds(attachments)).toEqual(
      "one two three four five six".split(" "),
    );
  });

  describe("resolveMSTeamsAdvertisedMedia", () => {
    it.each([
      { label: "no attachments", attachments: undefined, expected: [] },
      {
        label: "Teams download-info images",
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x.test/download", fileType: "png" },
          },
        ],
        expected: [{ kind: "image" }],
      },
    ])("recognizes $label", ({ attachments, expected }) => {
      expect(resolveMSTeamsAdvertisedMedia(attachments)).toEqual(expected);
    });

    it("aligns Graph hosted-content image URLs with their fallback resource id", () => {
      const hostedUrl =
        "https://graph.microsoft.com/v1.0/chats/chat/messages/message/hostedContents/hosted%2D1/$value";
      expectAdvertised(
        [createHtmlAttachment(`<img src="${hostedUrl}" />`)],
        [{ kind: "image", sourceId: "hosted-1" }],
      );
    });

    it("counts advertised files without URLs and ignores mention-only HTML", () => {
      expectAdvertised(
        [{ contentType: "application/pdf", name: "report.pdf" }],
        [{ kind: "document" }],
      );
      expectAdvertised([createHtmlAttachment("<div><at>Bot</at> hello</div>")], []);
    });

    it.each([
      [CONTENT_TYPE_APPLICATION_PDF, { contentUrl: "https://x/x.pdf" }, true],
      ["application/vnd.microsoft.card.adaptive", { content: { type: "AdaptiveCard" } }, false],
    ])("does not count HTML references separately from %s", (contentType, fields, isFile) => {
      expectAdvertised(
        [
          createHtmlAttachment('<attachment id="ref-1"></attachment>'),
          { id: "ref-1", contentType, ...fields },
        ],
        isFile ? [{ kind: "document", sourceId: "ref-1" }] : [],
      );
    });

    it("does not count CID image references separately from their attachment", () => {
      expectAdvertised(
        [
          createHtmlAttachment('<img src="cid:image-1" />'),
          {
            id: "image-1",
            contentType: "image/png",
            contentUrl: "https://x.test/image.png",
          },
        ],
        [{ kind: "image", sourceId: "image-1" }],
      );
    });

    it.each([
      ["emoji/smile/default/30_f.png", "🙂", false],
      ["emoji/1f44b/default/30_f.png", "", false],
      ["brand/brand.png", "brand.png", true],
    ])("classifies Teams CDN %s without hiding real images", (path, alt, isMedia) => {
      const url = `https://statics.teams.cdn.office.net/evergreen-assets/${path}`;
      expectAdvertised(
        [createHtmlAttachment(`<img src="${url}" alt="${alt}"><img src="https://x/photo.png">`)],
        [
          ...(isMedia ? [{ kind: "image" as const, sourceId: url }] : []),
          { kind: "image", sourceId: "https://x/photo.png" },
        ],
      );
    });

    it.each<[string, Parameters<typeof expectAdvertised>[1]]>([
      ["https://x/repeated.png", [{ kind: "image", sourceId: "https://x/repeated.png" }]],
      ["data:image/png;base64,AQ==", [{ kind: "image" }, { kind: "image" }]],
    ])("counts repeated URL/data occurrences correctly: %s", (src, expected) => {
      expectAdvertised([createHtmlAttachment(`<img src="${src}"><img src="${src}">`)], expected);
    });
  });

  describe("buildMSTeamsGraphMessageUrl", () => {
    it("builds a chat message URL", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "groupChat",
          conversationId: "19:chat@thread.v2",
          messageId: "456",
        }),
      ).toBe("https://graph.microsoft.com/v1.0/chats/19%3Achat%40thread.v2/messages/456");
    });

    it("fails closed when a canonical channel identifier is missing", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          messageId: "message-id",
          channelId: channelParams.channelId,
        }),
      ).toBeUndefined();
      expect(
        buildMSTeamsGraphMessageUrl({
          ...channelParams,
        }),
      ).toBeUndefined();
    });

    it("treats a matching thread root and message ID as a top-level message", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          ...channelParams,
          messageId: "root-id",
          threadRootMessageId: "root-id",
        }),
      ).toBe(`${GRAPH_CHANNEL_MESSAGES_ROOT}/root-id`);
    });

    it("encodes every channel path identifier", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          teamAadGroupId: "team/id",
          channelId: "channel id",
          messageId: "reply/id",
          threadRootMessageId: "root id",
        }),
      ).toBe(
        "https://graph.microsoft.com/v1.0/teams/team%2Fid/channels/channel%20id/messages/root%20id/replies/reply%2Fid",
      );
    });
  });
});
