import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsGraphMessageUrls,
  buildMSTeamsMediaPayload,
  downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia,
} from "./attachments.js";
import { setMSTeamsRuntime } from "./runtime.js";

vi.mock("openclaw/plugin-sdk", () => ({
  isPrivateIpAddress: () => false,
}));

/** Mock DNS resolver that always returns a public IP (for anti-SSRF validation in tests). */
const publicResolveFn = async () => ({ address: "13.107.136.10" });
const SAVED_PNG_PATH = "/tmp/saved.png";
const SAVED_PDF_PATH = "/tmp/saved.pdf";
const TEST_URL_IMAGE = "https://x/img";
const TEST_URL_IMAGE_PNG = "https://x/img.png";
const TEST_URL_IMAGE_1_PNG = "https://x/1.png";
const TEST_URL_IMAGE_2_JPG = "https://x/2.jpg";
const TEST_URL_PDF = "https://x/x.pdf";
const TEST_URL_PDF_1 = "https://x/1.pdf";
const TEST_URL_PDF_2 = "https://x/2.pdf";
const TEST_URL_HTML_A = "https://x/a.png";
const TEST_URL_HTML_B = "https://x/b.png";
const TEST_URL_INLINE_IMAGE = "https://x/inline.png";
const TEST_URL_DOC_PDF = "https://x/doc.pdf";
const TEST_URL_FILE_DOWNLOAD = "https://x/dl";
const TEST_URL_OUTSIDE_ALLOWLIST = "https://evil.test/img";
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_TEXT_HTML = "text/html";
const CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";

const detectMimeMock = vi.fn(async () => CONTENT_TYPE_IMAGE_PNG);
const saveMediaBufferMock = vi.fn(async () => ({
  path: SAVED_PNG_PATH,
  contentType: CONTENT_TYPE_IMAGE_PNG,
}));
const fetchRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    filePathHint?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
      throw new Error(`payload exceeds maxBytes ${params.maxBytes}`);
    }
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? undefined,
      fileName: params.filePathHint,
    };
  },
);

const runtimeStub = {
  media: {
    detectMime: detectMimeMock as unknown as PluginRuntime["media"]["detectMime"],
  },
  channel: {
    media: {
      fetchRemoteMedia:
        fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
      saveMediaBuffer:
        saveMediaBufferMock as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
    },
  },
} as unknown as PluginRuntime;

type DownloadAttachmentsParams = Parameters<typeof downloadMSTeamsAttachments>[0];
type DownloadGraphMediaParams = Parameters<typeof downloadMSTeamsGraphMedia>[0];
type DownloadedMedia = Awaited<ReturnType<typeof downloadMSTeamsAttachments>>;
type DownloadedGraphMedia = Awaited<ReturnType<typeof downloadMSTeamsGraphMedia>>;
type MSTeamsMediaPayload = ReturnType<typeof buildMSTeamsMediaPayload>;
type DownloadAttachmentsBuildOverrides = Partial<
  Omit<DownloadAttachmentsParams, "attachments" | "maxBytes" | "allowHosts" | "resolveFn">
> &
  Pick<DownloadAttachmentsParams, "allowHosts" | "resolveFn">;
type DownloadAttachmentsNoFetchOverrides = Partial<
  Omit<
    DownloadAttachmentsParams,
    "attachments" | "maxBytes" | "allowHosts" | "resolveFn" | "fetchFn"
  >
> &
  Pick<DownloadAttachmentsParams, "allowHosts" | "resolveFn">;
type DownloadGraphMediaOverrides = Partial<
  Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider" | "maxBytes">
>;
type FetchCallExpectation = { expectFetchCalled?: boolean };
type DownloadedMediaExpectation = { path?: string; placeholder?: string };
type MSTeamsMediaPayloadExpectation = {
  firstPath: string;
  paths: string[];
  types: string[];
};

const DEFAULT_MESSAGE_URL = "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = ["x"];
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = ["graph.microsoft.com", "contoso.sharepoint.com"];
const DEFAULT_SHARE_REFERENCE_URL = "https://contoso.sharepoint.com/site/file";
const MEDIA_PLACEHOLDER_IMAGE = "<media:image>";
const MEDIA_PLACEHOLDER_DOCUMENT = "<media:document>";
const IMAGE_ATTACHMENT = { contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: TEST_URL_IMAGE };
const PNG_BUFFER = Buffer.from("png");
const PNG_BASE64 = PNG_BUFFER.toString("base64");
const PDF_BUFFER = Buffer.from("pdf");
const createTokenProvider = () => ({ getAccessToken: vi.fn(async () => "token") });
const asSingleItemArray = <T>(value: T) => [value];
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) =>
  buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const buildHtmlImageTag = (src: string) => `<img src="${src}" />`;
const createHtmlImageAttachments = (sources: string[], prefix = "") =>
  asSingleItemArray(createHtmlAttachment(`${prefix}${sources.map(buildHtmlImageTag).join("")}`));
const createImageAttachments = (...contentUrls: string[]) =>
  contentUrls.map((contentUrl) => buildAttachment(CONTENT_TYPE_IMAGE_PNG, { contentUrl }));
const createPdfAttachments = (...contentUrls: string[]) =>
  contentUrls.map((contentUrl) => buildAttachment(CONTENT_TYPE_APPLICATION_PDF, { contentUrl }));
const createTeamsFileDownloadInfoAttachments = (
  downloadUrl = TEST_URL_FILE_DOWNLOAD,
  fileType = "png",
) =>
  asSingleItemArray(
    buildAttachment(CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO, {
      content: { downloadUrl, fileType },
    }),
  );
const createImageMediaEntries = (...paths: string[]) =>
  paths.map((path) => ({ path, contentType: CONTENT_TYPE_IMAGE_PNG }));
const createHostedImageContents = (...ids: string[]) =>
  ids.map((id) => ({ id, contentType: CONTENT_TYPE_IMAGE_PNG, contentBytes: PNG_BASE64 }));
const createPdfResponse = (payload: Buffer | string = PDF_BUFFER) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Response(new Uint8Array(raw), {
    status: 200,
    headers: { "content-type": CONTENT_TYPE_APPLICATION_PDF },
  });
};
const createJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });

const createOkFetchMock = (contentType: string, payload = "png") =>
  vi.fn(async () => {
    return new Response(Buffer.from(payload), {
      status: 200,
      headers: { "content-type": contentType },
    });
  });

const buildDownloadParams = (
  attachments: DownloadAttachmentsParams["attachments"],
  overrides: DownloadAttachmentsBuildOverrides = {},
): DownloadAttachmentsParams => {
  return {
    attachments,
    maxBytes: DEFAULT_MAX_BYTES,
    allowHosts: DEFAULT_ALLOW_HOSTS,
    resolveFn: publicResolveFn,
    ...overrides,
  };
};

const buildDownloadParamsWithFetch = (
  attachments: DownloadAttachmentsParams["attachments"],
  fetchFn: unknown,
  overrides: DownloadAttachmentsNoFetchOverrides = {},
): DownloadAttachmentsParams => {
  return buildDownloadParams(attachments, {
    ...overrides,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
};

const downloadAttachmentsWithFetch = async (
  attachments: DownloadAttachmentsParams["attachments"],
  fetchFn: unknown,
  overrides: DownloadAttachmentsNoFetchOverrides = {},
  options: FetchCallExpectation = {},
) => {
  const media = await downloadMSTeamsAttachments(
    buildDownloadParamsWithFetch(attachments, fetchFn, overrides),
  );
  expectMockCallState(fetchFn, options.expectFetchCalled ?? true);
  return media;
};
const downloadAttachmentsWithOkImageFetch = (
  attachments: DownloadAttachmentsParams["attachments"],
  overrides: DownloadAttachmentsNoFetchOverrides = {},
  options: FetchCallExpectation = {},
) => {
  return downloadAttachmentsWithFetch(
    attachments,
    createOkFetchMock(CONTENT_TYPE_IMAGE_PNG),
    overrides,
    options,
  );
};

const createAuthAwareImageFetchMock = (params: { unauthStatus: number; unauthBody: string }) =>
  vi.fn(async (_url: string, opts?: RequestInit) => {
    const headers = new Headers(opts?.headers);
    const hasAuth = Boolean(headers.get("Authorization"));
    if (!hasAuth) {
      return new Response(params.unauthBody, { status: params.unauthStatus });
    }
    return new Response(PNG_BUFFER, {
      status: 200,
      headers: { "content-type": CONTENT_TYPE_IMAGE_PNG },
    });
  });
const expectMockCallState = (mockFn: unknown, shouldCall: boolean) => {
  if (shouldCall) {
    expect(mockFn).toHaveBeenCalled();
  } else {
    expect(mockFn).not.toHaveBeenCalled();
  }
};

const buildDownloadGraphParams = (
  fetchFn: unknown,
  overrides: DownloadGraphMediaOverrides = {},
): DownloadGraphMediaParams => {
  return {
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  };
};
const DEFAULT_CHANNEL_TEAM_ID = "team-id";
const DEFAULT_CHANNEL_ID = "chan-id";
const createChannelGraphMessageUrlParams = (params: {
  messageId: string;
  replyToId?: string;
  conversationId?: string;
}) => ({
  conversationType: "channel" as const,
  ...params,
  channelData: {
    team: { id: DEFAULT_CHANNEL_TEAM_ID },
    channel: { id: DEFAULT_CHANNEL_ID },
  },
});
const buildExpectedChannelMessagePath = (params: { messageId: string; replyToId?: string }) =>
  params.replyToId
    ? `/teams/${DEFAULT_CHANNEL_TEAM_ID}/channels/${DEFAULT_CHANNEL_ID}/messages/${params.replyToId}/replies/${params.messageId}`
    : `/teams/${DEFAULT_CHANNEL_TEAM_ID}/channels/${DEFAULT_CHANNEL_ID}/messages/${params.messageId}`;

const downloadGraphMediaWithFetch = (
  fetchFn: unknown,
  overrides: DownloadGraphMediaOverrides = {},
) => {
  return downloadMSTeamsGraphMedia(buildDownloadGraphParams(fetchFn, overrides));
};
const expectFirstGraphUrlContains = (
  params: Parameters<typeof buildMSTeamsGraphMessageUrls>[0],
  expectedPath: string,
) => {
  const urls = buildMSTeamsGraphMessageUrls(params);
  expect(urls[0]).toContain(expectedPath);
};
const expectAttachmentPlaceholder = (
  attachments: Parameters<typeof buildMSTeamsAttachmentPlaceholder>[0],
  expected: string,
) => {
  expect(buildMSTeamsAttachmentPlaceholder(attachments)).toBe(expected);
};
const expectLength = (value: { length: number }, expectedLength: number) => {
  expect(value).toHaveLength(expectedLength);
};
const expectMediaLength = (media: DownloadedMedia, expectedLength: number) => {
  expectLength(media, expectedLength);
};
const expectGraphMediaLength = (media: DownloadedGraphMedia, expectedLength: number) => {
  expectLength(media.media, expectedLength);
};
const expectNoMedia = (media: DownloadedMedia) => {
  expectMediaLength(media, 0);
};
const expectSingleMedia = (media: DownloadedMedia, expected: DownloadedMediaExpectation = {}) => {
  expectMediaLength(media, 1);
  expectFirstMedia(media, expected);
};
const expectNoGraphMedia = (media: DownloadedGraphMedia) => {
  expectGraphMediaLength(media, 0);
};
const expectMediaSaved = () => {
  expect(saveMediaBufferMock).toHaveBeenCalled();
};
const expectFirstMedia = (media: DownloadedMedia, expected: DownloadedMediaExpectation) => {
  const first = media[0];
  if (expected.path !== undefined) {
    expect(first?.path).toBe(expected.path);
  }
  if (expected.placeholder !== undefined) {
    expect(first?.placeholder).toBe(expected.placeholder);
  }
};
const expectMSTeamsMediaPayload = (
  payload: MSTeamsMediaPayload,
  expected: MSTeamsMediaPayloadExpectation,
) => {
  expect(payload.MediaPath).toBe(expected.firstPath);
  expect(payload.MediaUrl).toBe(expected.firstPath);
  expect(payload.MediaPaths).toEqual(expected.paths);
  expect(payload.MediaUrls).toEqual(expected.paths);
  expect(payload.MediaTypes).toEqual(expected.types);
};
type AttachmentPlaceholderCase = {
  label: string;
  attachments: Parameters<typeof buildMSTeamsAttachmentPlaceholder>[0];
  expected: string;
};
type AttachmentDownloadSuccessCase = {
  label: string;
  attachments: DownloadAttachmentsParams["attachments"];
  assert?: (media: DownloadedMedia) => void;
};
type AttachmentAuthRetryScenario = {
  attachmentUrl: string;
  unauthStatus: number;
  unauthBody: string;
  overrides?: Omit<DownloadAttachmentsNoFetchOverrides, "tokenProvider">;
};
type AttachmentAuthRetryCase = {
  label: string;
  scenario: AttachmentAuthRetryScenario;
  expectedMediaLength: number;
  expectTokenFetch: boolean;
};
type GraphUrlExpectationCase = {
  label: string;
  params: Parameters<typeof buildMSTeamsGraphMessageUrls>[0];
  expectedPath: string;
};
type GraphMediaSuccessCase = {
  label: string;
  buildOptions: () => GraphFetchMockOptions;
  expectedLength: number;
  assert?: (params: {
    fetchMock: ReturnType<typeof createGraphFetchMock>;
    media: Awaited<ReturnType<typeof downloadMSTeamsGraphMedia>>;
  }) => void;
};

type GraphFetchMockOptions = {
  hostedContents?: unknown[];
  attachments?: unknown[];
  messageAttachments?: unknown[];
  onShareRequest?: (url: string) => Response | Promise<Response>;
  onUnhandled?: (url: string) => Response | Promise<Response> | undefined;
};

const createReferenceAttachment = (shareUrl = DEFAULT_SHARE_REFERENCE_URL) => ({
  id: "ref-1",
  contentType: "reference",
  contentUrl: shareUrl,
  name: "report.pdf",
});
const buildShareReferenceGraphFetchOptions = (params: {
  referenceAttachment: ReturnType<typeof createReferenceAttachment>;
  onShareRequest?: GraphFetchMockOptions["onShareRequest"];
  onUnhandled?: GraphFetchMockOptions["onUnhandled"];
}) => ({
  attachments: [params.referenceAttachment],
  messageAttachments: [params.referenceAttachment],
  ...(params.onShareRequest ? { onShareRequest: params.onShareRequest } : {}),
  ...(params.onUnhandled ? { onUnhandled: params.onUnhandled } : {}),
});
const buildDefaultShareReferenceGraphFetchOptions = (
  params: Omit<Parameters<typeof buildShareReferenceGraphFetchOptions>[0], "referenceAttachment">,
) =>
  buildShareReferenceGraphFetchOptions({
    referenceAttachment: createReferenceAttachment(),
    ...params,
  });

const createGraphFetchMock = (options: GraphFetchMockOptions = {}) => {
  const hostedContents = options.hostedContents ?? [];
  const attachments = options.attachments ?? [];
  const messageAttachments = options.messageAttachments ?? [];
  return vi.fn(async (url: string) => {
    if (url.endsWith("/hostedContents")) {
      return createJsonResponse({ value: hostedContents });
    }
    if (url.endsWith("/attachments")) {
      return createJsonResponse({ value: attachments });
    }
    if (url.endsWith("/messages/123")) {
      return createJsonResponse({ attachments: messageAttachments });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/shares/") && options.onShareRequest) {
      return options.onShareRequest(url);
    }
    const unhandled = options.onUnhandled ? await options.onUnhandled(url) : undefined;
    return unhandled ?? new Response("not found", { status: 404 });
  });
};
const downloadGraphMediaWithMockOptions = async (
  options: GraphFetchMockOptions = {},
  overrides: DownloadGraphMediaOverrides = {},
) => {
  const fetchMock = createGraphFetchMock(options);
  const media = await downloadGraphMediaWithFetch(fetchMock, overrides);
  return { fetchMock, media };
};
const runAttachmentAuthRetryScenario = async (scenario: AttachmentAuthRetryScenario) => {
  const tokenProvider = createTokenProvider();
  const fetchMock = createAuthAwareImageFetchMock({
    unauthStatus: scenario.unauthStatus,
    unauthBody: scenario.unauthBody,
  });
  const media = await downloadAttachmentsWithFetch(
    createImageAttachments(scenario.attachmentUrl),
    fetchMock,
    { tokenProvider, ...scenario.overrides },
  );
  return { tokenProvider, media };
};

describe("msteams attachments", () => {
  beforeEach(() => {
    detectMimeMock.mockClear();
    saveMediaBufferMock.mockClear();
    fetchRemoteMediaMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it.each<AttachmentPlaceholderCase>([
      { label: "returns empty string when no attachments", attachments: undefined, expected: "" },
      { label: "returns empty string when attachments are empty", attachments: [], expected: "" },
      {
        label: "returns image placeholder for one image attachment",
        attachments: createImageAttachments(TEST_URL_IMAGE_PNG),
        expected: MEDIA_PLACEHOLDER_IMAGE,
      },
      {
        label: "returns image placeholder with count for many image attachments",
        attachments: [
          ...createImageAttachments(TEST_URL_IMAGE_1_PNG),
          { contentType: "image/jpeg", contentUrl: TEST_URL_IMAGE_2_JPG },
        ],
        expected: `${MEDIA_PLACEHOLDER_IMAGE} (2 images)`,
      },
      {
        label: "treats Teams file.download.info image attachments as images",
        attachments: createTeamsFileDownloadInfoAttachments(),
        expected: MEDIA_PLACEHOLDER_IMAGE,
      },
      {
        label: "returns document placeholder for non-image attachments",
        attachments: createPdfAttachments(TEST_URL_PDF),
        expected: MEDIA_PLACEHOLDER_DOCUMENT,
      },
      {
        label: "returns document placeholder with count for many non-image attachments",
        attachments: createPdfAttachments(TEST_URL_PDF_1, TEST_URL_PDF_2),
        expected: `${MEDIA_PLACEHOLDER_DOCUMENT} (2 files)`,
      },
      {
        label: "counts one inline image in html attachments",
        attachments: createHtmlImageAttachments([TEST_URL_HTML_A], "<p>hi</p>"),
        expected: MEDIA_PLACEHOLDER_IMAGE,
      },
      {
        label: "counts many inline images in html attachments",
        attachments: createHtmlImageAttachments([TEST_URL_HTML_A, TEST_URL_HTML_B]),
        expected: `${MEDIA_PLACEHOLDER_IMAGE} (2 images)`,
      },
    ])("$label", ({ attachments, expected }) => {
      expectAttachmentPlaceholder(attachments, expected);
    });
  });

  describe("downloadMSTeamsAttachments", () => {
    it.each<AttachmentDownloadSuccessCase>([
      {
        label: "downloads and stores image contentUrl attachments",
        attachments: asSingleItemArray(IMAGE_ATTACHMENT),
        assert: (media) => {
          expectMediaSaved();
          expectFirstMedia(media, { path: SAVED_PNG_PATH });
        },
      },
      {
        label: "supports Teams file.download.info downloadUrl attachments",
        attachments: createTeamsFileDownloadInfoAttachments(),
      },
      {
        label: "downloads inline image URLs from html attachments",
        attachments: createHtmlImageAttachments([TEST_URL_INLINE_IMAGE]),
      },
    ])("$label", async ({ attachments, assert }) => {
      const media = await downloadAttachmentsWithOkImageFetch(attachments);
      expectSingleMedia(media);
      assert?.(media);
    });

    it("downloads non-image file attachments (PDF)", async () => {
      const fetchMock = createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf");
      detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
      saveMediaBufferMock.mockResolvedValueOnce({
        path: SAVED_PDF_PATH,
        contentType: CONTENT_TYPE_APPLICATION_PDF,
      });

      const media = await downloadAttachmentsWithFetch(
        createPdfAttachments(TEST_URL_DOC_PDF),
        fetchMock,
      );

      expectSingleMedia(media, {
        path: SAVED_PDF_PATH,
        placeholder: MEDIA_PLACEHOLDER_DOCUMENT,
      });
    });

    it("stores inline data:image base64 payloads", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([`data:image/png;base64,${PNG_BASE64}`]),
        ]),
      );

      expectSingleMedia(media);
      expectMediaSaved();
    });

    it.each<AttachmentAuthRetryCase>([
      {
        label: "retries with auth when the first request is unauthorized",
        scenario: {
          attachmentUrl: IMAGE_ATTACHMENT.contentUrl,
          unauthStatus: 401,
          unauthBody: "unauthorized",
          overrides: { authAllowHosts: ["x"] },
        },
        expectedMediaLength: 1,
        expectTokenFetch: true,
      },
      {
        label: "skips auth retries when the host is not in auth allowlist",
        scenario: {
          attachmentUrl: "https://attacker.azureedge.net/img",
          unauthStatus: 403,
          unauthBody: "forbidden",
          overrides: {
            allowHosts: ["azureedge.net"],
            authAllowHosts: ["graph.microsoft.com"],
          },
        },
        expectedMediaLength: 0,
        expectTokenFetch: false,
      },
    ])("$label", async ({ scenario, expectedMediaLength, expectTokenFetch }) => {
      const { tokenProvider, media } = await runAttachmentAuthRetryScenario(scenario);
      expectMediaLength(media, expectedMediaLength);
      expectMockCallState(tokenProvider.getAccessToken, expectTokenFetch);
    });

    it("skips urls outside the allowlist", async () => {
      const fetchMock = vi.fn();
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_OUTSIDE_ALLOWLIST),
        fetchMock,
        {
          allowHosts: ["graph.microsoft.com"],
          resolveFn: undefined,
        },
        { expectFetchCalled: false },
      );

      expectNoMedia(media);
    });
  });

  describe("buildMSTeamsGraphMessageUrls", () => {
    const cases: GraphUrlExpectationCase[] = [
      {
        label: "builds channel message urls",
        params: createChannelGraphMessageUrlParams({
          conversationId: "19:thread@thread.tacv2",
          messageId: "123",
        }),
        expectedPath: buildExpectedChannelMessagePath({ messageId: "123" }),
      },
      {
        label: "builds channel reply urls when replyToId is present",
        params: createChannelGraphMessageUrlParams({
          messageId: "reply-id",
          replyToId: "root-id",
        }),
        expectedPath: buildExpectedChannelMessagePath({
          messageId: "reply-id",
          replyToId: "root-id",
        }),
      },
      {
        label: "builds chat message urls",
        params: {
          conversationType: "groupChat" as const,
          conversationId: "19:chat@thread.v2",
          messageId: "456",
        },
        expectedPath: "/chats/19%3Achat%40thread.v2/messages/456",
      },
    ];

    it.each(cases)("$label", ({ params, expectedPath }) => {
      expectFirstGraphUrlContains(params, expectedPath);
    });
  });

  describe("downloadMSTeamsGraphMedia", () => {
    it.each<GraphMediaSuccessCase>([
      {
        label: "downloads hostedContents images",
        buildOptions: () => ({ hostedContents: createHostedImageContents("1") }),
        expectedLength: 1,
        assert: ({ fetchMock }) => {
          expect(fetchMock).toHaveBeenCalled();
          expectMediaSaved();
        },
      },
      {
        label: "merges SharePoint reference attachments with hosted content",
        buildOptions: () => {
          return {
            hostedContents: createHostedImageContents("hosted-1"),
            ...buildDefaultShareReferenceGraphFetchOptions({
              onShareRequest: () => createPdfResponse(),
            }),
          };
        },
        expectedLength: 2,
      },
    ])("$label", async ({ buildOptions, expectedLength, assert }) => {
      const { fetchMock, media } = await downloadGraphMediaWithMockOptions(buildOptions());
      expectGraphMediaLength(media, expectedLength);
      assert?.({ fetchMock, media });
    });

    it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
      const escapedUrl = "https://evil.example/internal.pdf";
      fetchRemoteMediaMock.mockImplementationOnce(async (params) => {
        const fetchFn = params.fetchImpl ?? fetch;
        let currentUrl = params.url;
        for (let i = 0; i < 5; i += 1) {
          const res = await fetchFn(currentUrl, { redirect: "manual" });
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            if (!location) {
              throw new Error("redirect missing location");
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: res.headers.get("content-type") ?? undefined,
            fileName: params.filePathHint,
          };
        }
        throw new Error("too many redirects");
      });

      const { fetchMock, media } = await downloadGraphMediaWithMockOptions(
        {
          ...buildDefaultShareReferenceGraphFetchOptions({
            onShareRequest: () =>
              new Response(null, {
                status: 302,
                headers: { location: escapedUrl },
              }),
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

      expectNoGraphMedia(media);
      const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        calledUrls.some((url) => url.startsWith("https://graph.microsoft.com/v1.0/shares/")),
      ).toBe(true);
      expect(calledUrls).not.toContain(escapedUrl);
    });
  });

  describe("buildMSTeamsMediaPayload", () => {
    it("returns single and multi-file fields", async () => {
      const payload = buildMSTeamsMediaPayload(createImageMediaEntries("/tmp/a.png", "/tmp/b.png"));
      expectMSTeamsMediaPayload(payload, {
        firstPath: "/tmp/a.png",
        paths: ["/tmp/a.png", "/tmp/b.png"],
        types: [CONTENT_TYPE_IMAGE_PNG, CONTENT_TYPE_IMAGE_PNG],
      });
    });
  });
});
