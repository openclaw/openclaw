// Msteams tests cover attachments.graph plugin behavior.
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import type { PluginRuntime } from "../runtime-api.js";
import { buildMSTeamsGraphMessageUrl, resolveMSTeamsAdvertisedMedia } from "./attachments.js";
import { downloadMSTeamsGraphMedia } from "./attachments/graph.js";
import { encodeGraphShareId } from "./attachments/shared.js";
import { setMSTeamsRuntime } from "./runtime.js";

const GRAPH_HOST = "graph.microsoft.com";
const SHAREPOINT_HOST = "contoso.sharepoint.com";
const DEFAULT_MESSAGE_URL = `https://${GRAPH_HOST}/v1.0/chats/19%3Achat/messages/123`;
const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = [GRAPH_HOST, SHAREPOINT_HOST];
const DEFAULT_SHARE_REFERENCE_URL = `https://${SHAREPOINT_HOST}/site/file`;
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const PNG_BUFFER = Buffer.from("png");

const detectMimeMock = vi.fn(async () => CONTENT_TYPE_IMAGE_PNG);
const saveMediaBufferMock = vi.fn(
  async (
    _buffer: Buffer,
    contentType?: string,
    _subdir?: string,
    _maxBytes?: number,
    _originalFilename?: string,
  ) => ({
    id: "saved.png",
    path: "/tmp/saved.png",
    size: Buffer.byteLength(PNG_BUFFER),
    contentType: contentType ?? CONTENT_TYPE_IMAGE_PNG,
  }),
);
const saveResponseMediaMock = vi.fn(
  async (
    res: Response,
    options: {
      maxBytes?: number;
      fallbackContentType?: string;
      subdir?: string;
      originalFilename?: string;
    },
  ) => {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
      throw new Error(`payload exceeds maxBytes ${options.maxBytes}`);
    }
    return await saveMediaBufferMock(
      buffer,
      options.fallbackContentType,
      options.subdir ?? "inbound",
      options.maxBytes,
      options.originalFilename,
    );
  },
);

const runtimeStub = {
  media: {
    detectMime: detectMimeMock,
  },
  channel: {
    media: {
      saveResponseMedia: saveResponseMediaMock,
      saveMediaBuffer: saveMediaBufferMock,
    },
  },
} as unknown as PluginRuntime;

type DownloadGraphMediaParams = Parameters<typeof downloadMSTeamsGraphMedia>[0];
type DownloadGraphMediaOverrides = Partial<
  Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider">
>;
type GraphFetchMockOptions = {
  hostedContents?: unknown[];
  messageAttachments?: unknown[];
  onShareRequest?: (url: string) => Response | Promise<Response>;
  onUnhandled?: (url: string) => Response | Promise<Response> | undefined;
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
const createGraphCollectionResponse = (value: unknown[]) => createJsonResponse({ value });
const createNotFoundResponse = () => new Response("not found", { status: 404 });
const createRedirectResponse = (location: string) =>
  new Response(null, { status: 302, headers: { location } });
const createHostedImageContents = (...ids: string[]) =>
  ids.map((id) => ({ id, contentType: CONTENT_TYPE_IMAGE_PNG }));
const createReferenceAttachment = () => ({
  id: "ref-1",
  contentType: "reference",
  contentUrl: DEFAULT_SHARE_REFERENCE_URL,
  name: "report.pdf",
});
const buildDefaultShareReferenceGraphFetchOptions = (options: GraphFetchMockOptions) => ({
  messageAttachments: [createReferenceAttachment()],
  ...options,
});
const createGraphFetchMock = (options: GraphFetchMockOptions = {}) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = resolveRequestUrl(input);
    if (url === DEFAULT_MESSAGE_URL) {
      return createJsonResponse({ attachments: options.messageAttachments ?? [] });
    }
    if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
      return createGraphCollectionResponse(options.hostedContents ?? []);
    }
    if (url.startsWith(GRAPH_SHARES_URL_PREFIX) && options.onShareRequest) {
      return options.onShareRequest(url);
    }
    return (await options.onUnhandled?.(url)) ?? createNotFoundResponse();
  });
const downloadGraphMediaWithMockOptions = async (
  options: GraphFetchMockOptions = {},
  overrides: DownloadGraphMediaOverrides = {},
) => {
  const fetchMock = createGraphFetchMock(options);
  const media = await downloadMSTeamsGraphMedia({
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn: fetchMock,
    resolveFn: resolvePublicHost,
    ...overrides,
  });
  return { fetchMock, media };
};

describe("msteams graph attachments", () => {
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = mockPinnedHostnameResolution();
    detectMimeMock.mockClear();
    saveResponseMediaMock.mockClear();
    saveMediaBufferMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  it("merges SharePoint reference attachments with hosted content", async () => {
    const { media } = await downloadGraphMediaWithMockOptions({
      hostedContents: createHostedImageContents("hosted-1"),
      ...buildDefaultShareReferenceGraphFetchOptions({
        onShareRequest: () => createPdfResponse(),
        onUnhandled: (url) =>
          url.endsWith("/hostedContents/hosted-1/$value")
            ? createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG)
            : undefined,
      }),
    });
    expect(media.media).toHaveLength(2);
  });

  it("cancels non-OK Graph collection bodies before returning empty hosted content", async () => {
    const tracked = cancelTrackedTextResponse("missing hosted contents", { status: 404 });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveRequestUrl(input);
      if (url === DEFAULT_MESSAGE_URL) {
        return createJsonResponse({ attachments: [] });
      }
      if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
        return tracked.response;
      }
      return createNotFoundResponse();
    });

    const media = await downloadMSTeamsGraphMedia({
      messageUrl: DEFAULT_MESSAGE_URL,
      tokenProvider: createTokenProvider(),
      maxBytes: DEFAULT_MAX_BYTES,
      fetchFn: fetchMock,
      resolveFn: resolvePublicHost,
    });

    expect(media.media).toEqual([]);
    expect(media.hostedStatus).toBe(404);
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("does not forward Authorization for SharePoint redirects outside auth allowlist", async () => {
    const tokenProvider = createTokenProvider("top-secret-token");
    const escapedUrl = "https://example.com/collect";
    const seen: Array<{ url: string; auth: string }> = [];
    const referenceAttachment = createReferenceAttachment();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveRequestUrl(input);
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seen.push({ url, auth });

      if (url === DEFAULT_MESSAGE_URL) {
        return createJsonResponse({ attachments: [referenceAttachment] });
      }
      if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
        return createGraphCollectionResponse([]);
      }
      if (url.startsWith(GRAPH_SHARES_URL_PREFIX)) {
        return createRedirectResponse(escapedUrl);
      }
      if (url === escapedUrl) {
        return createPdfResponse();
      }
      return createNotFoundResponse();
    });

    const media = await downloadMSTeamsGraphMedia({
      messageUrl: DEFAULT_MESSAGE_URL,
      tokenProvider,
      maxBytes: DEFAULT_MAX_BYTES,
      allowHosts: [...DEFAULT_SHAREPOINT_ALLOW_HOSTS, "example.com"],
      authAllowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
      fetchFn: fetchMock,
      resolveFn: resolvePublicHost,
    });

    expect(media.media).toHaveLength(1);
    const redirected = seen.find((entry) => entry.url === escapedUrl);
    if (!redirected) {
      throw new Error("expected SharePoint redirect request to be observed");
    }
    expect(redirected.auth).toBe("");
  });

  it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
    const escapedUrl = "https://evil.example/internal.pdf";
    const { fetchMock, media } = await downloadGraphMediaWithMockOptions(
      {
        ...buildDefaultShareReferenceGraphFetchOptions({
          onShareRequest: () => createRedirectResponse(escapedUrl),
          onUnhandled: (url) => {
            if (url === escapedUrl) {
              return createPdfResponse("should-not-be-fetched");
            }
            return undefined;
          },
        }),
      },
      {
        allowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS,
      },
    );

    expect(media.media).toEqual([{ kind: "document", sourceId: "ref-1" }]);
    const calledUrls = fetchMock.mock.calls.map(([input]) => resolveRequestUrl(input));
    const expectedSharesUrl = `${GRAPH_SHARES_URL_PREFIX}${encodeGraphShareId(DEFAULT_SHARE_REFERENCE_URL)}/driveItem/content`;
    expect(calledUrls).toEqual([
      DEFAULT_MESSAGE_URL,
      expectedSharesUrl,
      `${DEFAULT_MESSAGE_URL}/hostedContents`,
    ]);
    expect(calledUrls).not.toContain(escapedUrl);
  });

  it("enforces maxBytes while streaming hosted content", async () => {
    const { media } = await downloadGraphMediaWithMockOptions(
      {
        hostedContents: createHostedImageContents("hosted-oversized"),
        onUnhandled: (url) =>
          url.endsWith("/hostedContents/hosted-oversized/$value")
            ? createBufferResponse("too large", CONTENT_TYPE_IMAGE_PNG)
            : undefined,
      },
      { maxBytes: 4 },
    );

    expect(media.media).toStrictEqual([
      { kind: "image", contentType: "image/png", sourceId: "hosted-oversized" },
    ]);
    expect(saveResponseMediaMock).toHaveBeenCalledTimes(1);
  });
});

const TEST_HOST = "x";
const createUrlForHost = (host: string, pathSegment: string) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment: string) => createUrlForHost(TEST_HOST, pathSegment);
const TEST_URL_PDF = createTestUrl("x.pdf");
const CONTENT_TYPE_TEXT_HTML = "text/html";
type GraphMessageUrlParams = Parameters<typeof buildMSTeamsGraphMessageUrl>[0];
const withLabel = <T extends object>(label: string, fields: T): T & { label: string } => ({
  label,
  ...fields,
});
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) =>
  buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const DEFAULT_CHANNEL_TEAM_ID = "team-id";
const DEFAULT_CHANNEL_ID = "chan-id";
const createChannelGraphMessageUrlParams = (
  params: Pick<GraphMessageUrlParams, "messageId" | "threadRootMessageId">,
) => ({
  conversationType: "channel" as const,
  teamAadGroupId: DEFAULT_CHANNEL_TEAM_ID,
  channelId: DEFAULT_CHANNEL_ID,
  ...params,
});
const GRAPH_CHANNEL_MESSAGES_ROOT =
  "https://graph.microsoft.com/v1.0/teams/team-id/channels/chan-id/messages";

const ADVERTISED_MEDIA_CASES = [
  withLabel("returns no facts without attachments", {
    attachments: undefined,
    expected: [],
  }),

  withLabel("recognizes Teams download-info images", {
    attachments: [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        content: { downloadUrl: "https://x.test/download", fileType: "png" },
      },
    ],
    expected: [{ kind: "image" }],
  }),
];

const GRAPH_MESSAGE_URL_CASES = [
  withLabel("builds a channel top-level message URL", {
    params: createChannelGraphMessageUrlParams({
      messageId: "123",
    }),
    expectedUrl: `${GRAPH_CHANNEL_MESSAGES_ROOT}/123`,
  }),

  withLabel("builds a chat message URL", {
    params: {
      conversationType: "groupChat" as const,
      conversationId: "19:chat@thread.v2",
      messageId: "456",
    } satisfies GraphMessageUrlParams,
    expectedUrl: "https://graph.microsoft.com/v1.0/chats/19%3Achat%40thread.v2/messages/456",
  }),
];

describe("msteams attachment helpers", () => {
  describe("resolveMSTeamsAdvertisedMedia", () => {
    it.each(ADVERTISED_MEDIA_CASES)("$label", ({ attachments, expected }) => {
      expect(resolveMSTeamsAdvertisedMedia(attachments)).toEqual(expected);
    });

    it("aligns Graph hosted-content image URLs with their fallback resource id", () => {
      const hostedUrl =
        "https://graph.microsoft.com/v1.0/chats/chat/messages/message/hostedContents/hosted%2D1/$value";
      expect(
        resolveMSTeamsAdvertisedMedia([createHtmlAttachment(`<img src="${hostedUrl}" />`)]),
      ).toEqual([{ kind: "image", sourceId: "hosted-1" }]);
    });

    it("counts advertised files without URLs and ignores mention-only HTML", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([{ contentType: "application/pdf", name: "report.pdf" }]),
      ).toEqual([{ kind: "document" }]);
      expect(
        resolveMSTeamsAdvertisedMedia([
          { contentType: "text/html", content: "<div><at>Bot</at> hello</div>" },
        ]),
      ).toEqual([]);
    });

    it("does not count HTML references separately from files or cards", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<attachment id="file-1"></attachment>'),
          {
            id: "file-1",
            contentType: CONTENT_TYPE_APPLICATION_PDF,
            contentUrl: TEST_URL_PDF,
          },
        ]),
      ).toEqual([{ kind: "document", sourceId: "file-1" }]);

      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<attachment id="card-1"></attachment>'),
          {
            id: "card-1",
            contentType: "application/vnd.microsoft.card.adaptive",
            content: { type: "AdaptiveCard" },
          },
        ]),
      ).toEqual([]);
    });

    it("does not count CID image references separately from their attachment", () => {
      expect(
        resolveMSTeamsAdvertisedMedia([
          createHtmlAttachment('<img src="cid:image-1" />'),
          {
            id: "image-1",
            contentType: "image/png",
            contentUrl: "https://x.test/image.png",
          },
        ]),
      ).toEqual([{ kind: "image", sourceId: "image-1" }]);
    });

    it("counts repeated inline URLs once while keeping data images per occurrence", () => {
      const repeatedUrl = "https://example.com/repeated.png";
      expect(
        resolveMSTeamsAdvertisedMedia([
          {
            contentType: "text/html",
            content: `<img src="${repeatedUrl}"><img src="${repeatedUrl}">`,
          },
        ]),
      ).toEqual([{ kind: "image", sourceId: repeatedUrl }]);

      const dataUrl = "data:image/png;base64,AQ==";
      expect(
        resolveMSTeamsAdvertisedMedia([
          {
            contentType: "text/html",
            content: `<img src="${dataUrl}"><img src="${dataUrl}">`,
          },
        ]),
      ).toEqual([{ kind: "image" }, { kind: "image" }]);
    });
  });

  describe("buildMSTeamsGraphMessageUrl", () => {
    it.each(GRAPH_MESSAGE_URL_CASES)("$label", ({ params, expectedUrl }) => {
      expect(buildMSTeamsGraphMessageUrl(params)).toBe(expectedUrl);
    });

    it("fails closed when a canonical channel identifier is missing", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          messageId: "message-id",
          channelId: DEFAULT_CHANNEL_ID,
        }),
      ).toBeUndefined();
      expect(
        buildMSTeamsGraphMessageUrl({
          conversationType: "channel",
          teamAadGroupId: DEFAULT_CHANNEL_TEAM_ID,
          channelId: DEFAULT_CHANNEL_ID,
        }),
      ).toBeUndefined();
    });

    it("treats a matching thread root and message ID as a top-level message", () => {
      expect(
        buildMSTeamsGraphMessageUrl({
          ...createChannelGraphMessageUrlParams({
            messageId: "root-id",
            threadRootMessageId: "root-id",
          }),
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
