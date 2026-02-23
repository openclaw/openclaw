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
const GRAPH_HOST = "graph.microsoft.com";
const SHAREPOINT_HOST = "contoso.sharepoint.com";
const AZUREEDGE_HOST = "azureedge.net";
const TEST_HOST = "x";
const createUrlForHost = (host: string, pathSegment: string) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment: string) => createUrlForHost(TEST_HOST, pathSegment);
const SAVED_PNG_PATH = "/tmp/saved.png";
const SAVED_PDF_PATH = "/tmp/saved.pdf";
const TEST_URL_IMAGE = createTestUrl("img");
const TEST_URL_IMAGE_PNG = createTestUrl("img.png");
const TEST_URL_IMAGE_1_PNG = createTestUrl("1.png");
const TEST_URL_IMAGE_2_JPG = createTestUrl("2.jpg");
const TEST_URL_PDF = createTestUrl("x.pdf");
const TEST_URL_PDF_1 = createTestUrl("1.pdf");
const TEST_URL_PDF_2 = createTestUrl("2.pdf");
const TEST_URL_HTML_A = createTestUrl("a.png");
const TEST_URL_HTML_B = createTestUrl("b.png");
const TEST_URL_INLINE_IMAGE = createTestUrl("inline.png");
const TEST_URL_DOC_PDF = createTestUrl("doc.pdf");
const TEST_URL_FILE_DOWNLOAD = createTestUrl("dl");
const TEST_URL_OUTSIDE_ALLOWLIST = "https://evil.test/img";
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_APPLICATION_PDF = "application/pdf";
const CONTENT_TYPE_TEXT_HTML = "text/html";
const CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
const MAX_REDIRECT_HOPS = 5;
type RemoteMediaFetchParams = {
  url: string;
  maxBytes?: number;
  filePathHint?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const detectMimeMock = vi.fn(async () => CONTENT_TYPE_IMAGE_PNG);
const saveMediaBufferMock = vi.fn(async () => ({
  path: SAVED_PNG_PATH,
  contentType: CONTENT_TYPE_IMAGE_PNG,
}));
const readRemoteMediaResponse = async (
  res: Response,
  params: Pick<RemoteMediaFetchParams, "maxBytes" | "filePathHint">,
) => {
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
};
const fetchRemoteMediaMock = vi.fn(async (params: RemoteMediaFetchParams) => {
  const fetchFn = params.fetchImpl ?? fetch;
  const res = await fetchFn(params.url);
  return readRemoteMediaResponse(res, params);
});

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
type FetchFn = typeof fetch;
type MSTeamsAttachments = DownloadAttachmentsParams["attachments"];
type AttachmentPlaceholderInput = Parameters<typeof buildMSTeamsAttachmentPlaceholder>[0];
type GraphMessageUrlParams = Parameters<typeof buildMSTeamsGraphMessageUrls>[0];
type LabeledCase = { label: string };
type FetchCallExpectation = { expectFetchCalled?: boolean };
type DownloadedMediaExpectation = { path?: string; placeholder?: string };
type MSTeamsMediaPayloadExpectation = {
  firstPath: string;
  paths: string[];
  types: string[];
};

const DEFAULT_MESSAGE_URL = `https://${GRAPH_HOST}/v1.0/chats/19%3Achat/messages/123`;
const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = [TEST_HOST];
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = [GRAPH_HOST, SHAREPOINT_HOST];
const DEFAULT_SHARE_REFERENCE_URL = createUrlForHost(SHAREPOINT_HOST, "site/file");
const MEDIA_PLACEHOLDER_IMAGE = "<media:image>";
const MEDIA_PLACEHOLDER_DOCUMENT = "<media:document>";
const formatImagePlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_IMAGE} (${count} images)` : MEDIA_PLACEHOLDER_IMAGE;
const formatDocumentPlaceholder = (count: number) =>
  count > 1 ? `${MEDIA_PLACEHOLDER_DOCUMENT} (${count} files)` : MEDIA_PLACEHOLDER_DOCUMENT;
const IMAGE_ATTACHMENT = { contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: TEST_URL_IMAGE };
const PNG_BUFFER = Buffer.from("png");
const PNG_BASE64 = PNG_BUFFER.toString("base64");
const PDF_BUFFER = Buffer.from("pdf");
const createTokenProvider = () => ({ getAccessToken: vi.fn(async () => "token") });
const asSingleItemArray = <T>(value: T) => [value];
const withLabel = <T extends object>(label: string, fields: T): T & LabeledCase => ({
  label,
  ...fields,
});
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) =>
  buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const buildHtmlImageTag = (src: string) => `<img src="${src}" />`;
const createHtmlImageAttachments = (sources: string[], prefix = "") =>
  asSingleItemArray(createHtmlAttachment(`${prefix}${sources.map(buildHtmlImageTag).join("")}`));
const createContentUrlAttachments = (contentType: string, ...contentUrls: string[]) =>
  contentUrls.map((contentUrl) => buildAttachment(contentType, { contentUrl }));
const createImageAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_IMAGE_PNG, ...contentUrls);
const createPdfAttachments = (...contentUrls: string[]) =>
  createContentUrlAttachments(CONTENT_TYPE_APPLICATION_PDF, ...contentUrls);
const createTeamsFileDownloadInfoAttachments = (
  downloadUrl = TEST_URL_FILE_DOWNLOAD,
  fileType = "png",
) =>
  asSingleItemArray(
    buildAttachment(CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO, {
      content: { downloadUrl, fileType },
    }),
  );
const createMediaEntriesWithType = (contentType: string, ...paths: string[]) =>
  paths.map((path) => ({ path, contentType }));
const createHostedContentsWithType = (contentType: string, ...ids: string[]) =>
  ids.map((id) => ({ id, contentType, contentBytes: PNG_BASE64 }));
const createImageMediaEntries = (...paths: string[]) =>
  createMediaEntriesWithType(CONTENT_TYPE_IMAGE_PNG, ...paths);
const createHostedImageContents = (...ids: string[]) =>
  createHostedContentsWithType(CONTENT_TYPE_IMAGE_PNG, ...ids);
const createPdfResponse = (payload: Buffer | string = PDF_BUFFER) => {
  return createBufferResponse(payload, CONTENT_TYPE_APPLICATION_PDF);
};
const createBufferResponse = (payload: Buffer | string, contentType: string, status = 200) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Response(new Uint8Array(raw), {
    status,
    headers: { "content-type": contentType },
  });
};
const createJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });
const createTextResponse = (body: string, status = 200) => new Response(body, { status });
const createGraphCollectionResponse = (value: unknown[]) => createJsonResponse({ value });
const createNotFoundResponse = () => new Response("not found", { status: 404 });
const createRedirectResponse = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const createOkFetchMock = (contentType: string, payload = "png") =>
  vi.fn(async () => createBufferResponse(payload, contentType));
const asFetchFn = (fetchFn: unknown): FetchFn => fetchFn as FetchFn;

const buildDownloadParams = (
  attachments: MSTeamsAttachments,
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

const downloadAttachmentsWithFetch = async (
  attachments: MSTeamsAttachments,
  fetchFn: unknown,
  overrides: DownloadAttachmentsNoFetchOverrides = {},
  options: FetchCallExpectation = {},
) => {
  const media = await downloadMSTeamsAttachments(
    buildDownloadParams(attachments, {
      ...overrides,
      fetchFn: asFetchFn(fetchFn),
    }),
  );
  expectMockCallState(fetchFn, options.expectFetchCalled ?? true);
  return media;
};

const createAuthAwareImageFetchMock = (params: { unauthStatus: number; unauthBody: string }) =>
  vi.fn(async (_url: string, opts?: RequestInit) => {
    const headers = new Headers(opts?.headers);
    const hasAuth = Boolean(headers.get("Authorization"));
    if (!hasAuth) {
      return createTextResponse(params.unauthBody, params.unauthStatus);
    }
    return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
  });
const expectMockCallState = (mockFn: unknown, shouldCall: boolean) => {
  if (shouldCall) {
    expect(mockFn).toHaveBeenCalled();
  } else {
    expect(mockFn).not.toHaveBeenCalled();
  }
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

const expectAttachmentMediaLength = (media: DownloadedMedia, expectedLength: number) => {
  expect(media).toHaveLength(expectedLength);
};
const expectSingleMedia = (media: DownloadedMedia, expected: DownloadedMediaExpectation = {}) => {
  expectAttachmentMediaLength(media, 1);
  expectFirstMedia(media, expected);
};
const expectMediaBufferSaved = () => {
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
type AttachmentPlaceholderCase = LabeledCase & {
  attachments: AttachmentPlaceholderInput;
  expected: string;
};
type CountedAttachmentPlaceholderCaseDef = LabeledCase & {
  attachments: AttachmentPlaceholderCase["attachments"];
  count: number;
  formatPlaceholder: (count: number) => string;
};
type AttachmentDownloadSuccessCase = LabeledCase & {
  attachments: MSTeamsAttachments;
  buildFetchFn?: () => unknown;
  beforeDownload?: () => void;
  assert?: (media: DownloadedMedia) => void;
};
type AttachmentAuthRetryScenario = {
  attachmentUrl: string;
  unauthStatus: number;
  unauthBody: string;
  overrides?: Omit<DownloadAttachmentsNoFetchOverrides, "tokenProvider">;
};
type AttachmentAuthRetryCase = LabeledCase & {
  scenario: AttachmentAuthRetryScenario;
  expectedMediaLength: number;
  expectTokenFetch: boolean;
};
type GraphUrlExpectationCase = LabeledCase & {
  params: GraphMessageUrlParams;
  expectedPath: string;
};
type ChannelGraphUrlCaseParams = {
  messageId: string;
  replyToId?: string;
  conversationId?: string;
};
type GraphMediaDownloadResult = {
  fetchMock: ReturnType<typeof createGraphFetchMock>;
  media: Awaited<ReturnType<typeof downloadMSTeamsGraphMedia>>;
};
type GraphMediaSuccessCase = LabeledCase & {
  buildOptions: () => GraphFetchMockOptions;
  expectedLength: number;
  assert?: (params: GraphMediaDownloadResult) => void;
};
const EMPTY_ATTACHMENT_PLACEHOLDER_CASES: AttachmentPlaceholderCase[] = [
  withLabel("returns empty string when no attachments", { attachments: undefined, expected: "" }),
  withLabel("returns empty string when attachments are empty", { attachments: [], expected: "" }),
];
const COUNTED_ATTACHMENT_PLACEHOLDER_CASE_DEFS: CountedAttachmentPlaceholderCaseDef[] = [
  withLabel("returns image placeholder for one image attachment", {
    attachments: createImageAttachments(TEST_URL_IMAGE_PNG),
    count: 1,
    formatPlaceholder: formatImagePlaceholder,
  }),
  withLabel("returns image placeholder with count for many image attachments", {
    attachments: [
      ...createImageAttachments(TEST_URL_IMAGE_1_PNG),
      { contentType: "image/jpeg", contentUrl: TEST_URL_IMAGE_2_JPG },
    ],
    count: 2,
    formatPlaceholder: formatImagePlaceholder,
  }),
  withLabel("treats Teams file.download.info image attachments as images", {
    attachments: createTeamsFileDownloadInfoAttachments(),
    count: 1,
    formatPlaceholder: formatImagePlaceholder,
  }),
  withLabel("returns document placeholder for non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF),
    count: 1,
    formatPlaceholder: formatDocumentPlaceholder,
  }),
  withLabel("returns document placeholder with count for many non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF_1, TEST_URL_PDF_2),
    count: 2,
    formatPlaceholder: formatDocumentPlaceholder,
  }),
  withLabel("counts one inline image in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A], "<p>hi</p>"),
    count: 1,
    formatPlaceholder: formatImagePlaceholder,
  }),
  withLabel("counts many inline images in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A, TEST_URL_HTML_B]),
    count: 2,
    formatPlaceholder: formatImagePlaceholder,
  }),
];
const ATTACHMENT_PLACEHOLDER_CASES: AttachmentPlaceholderCase[] = [
  ...EMPTY_ATTACHMENT_PLACEHOLDER_CASES,
  ...COUNTED_ATTACHMENT_PLACEHOLDER_CASE_DEFS.map((testCase) =>
    withLabel(testCase.label, {
      attachments: testCase.attachments,
      expected: testCase.formatPlaceholder(testCase.count),
    }),
  ),
];
const ATTACHMENT_DOWNLOAD_SUCCESS_CASES: AttachmentDownloadSuccessCase[] = [
  withLabel("downloads and stores image contentUrl attachments", {
    attachments: asSingleItemArray(IMAGE_ATTACHMENT),
    assert: (media) => {
      expectFirstMedia(media, { path: SAVED_PNG_PATH });
      expectMediaBufferSaved();
    },
  }),
  withLabel("supports Teams file.download.info downloadUrl attachments", {
    attachments: createTeamsFileDownloadInfoAttachments(),
  }),
  withLabel("downloads inline image URLs from html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_INLINE_IMAGE]),
  }),
  withLabel("downloads non-image file attachments (PDF)", {
    attachments: createPdfAttachments(TEST_URL_DOC_PDF),
    buildFetchFn: () => createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf"),
    beforeDownload: () => {
      detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
      saveMediaBufferMock.mockResolvedValueOnce({
        path: SAVED_PDF_PATH,
        contentType: CONTENT_TYPE_APPLICATION_PDF,
      });
    },
    assert: (media) => {
      expectSingleMedia(media, {
        path: SAVED_PDF_PATH,
        placeholder: formatDocumentPlaceholder(1),
      });
    },
  }),
];
const ATTACHMENT_AUTH_RETRY_CASES: AttachmentAuthRetryCase[] = [
  withLabel("retries with auth when the first request is unauthorized", {
    scenario: {
      attachmentUrl: IMAGE_ATTACHMENT.contentUrl,
      unauthStatus: 401,
      unauthBody: "unauthorized",
      overrides: { authAllowHosts: [TEST_HOST] },
    },
    expectedMediaLength: 1,
    expectTokenFetch: true,
  }),
  withLabel("skips auth retries when the host is not in auth allowlist", {
    scenario: {
      attachmentUrl: createUrlForHost(AZUREEDGE_HOST, "img"),
      unauthStatus: 403,
      unauthBody: "forbidden",
      overrides: {
        allowHosts: [AZUREEDGE_HOST],
        authAllowHosts: [GRAPH_HOST],
      },
    },
    expectedMediaLength: 0,
    expectTokenFetch: false,
  }),
];
const GRAPH_MEDIA_SUCCESS_CASES: GraphMediaSuccessCase[] = [
  withLabel("downloads hostedContents images", {
    buildOptions: () => ({ hostedContents: createHostedImageContents("1") }),
    expectedLength: 1,
    assert: ({ fetchMock }) => {
      expect(fetchMock).toHaveBeenCalled();
      expectMediaBufferSaved();
    },
  }),
  withLabel("merges SharePoint reference attachments with hosted content", {
    buildOptions: () => {
      return {
        hostedContents: createHostedImageContents("hosted-1"),
        ...buildDefaultShareReferenceGraphFetchOptions({
          onShareRequest: () => createPdfResponse(),
        }),
      };
    },
    expectedLength: 2,
  }),
];
const CHANNEL_GRAPH_URL_CASES: Array<LabeledCase & ChannelGraphUrlCaseParams> = [
  withLabel("builds channel message urls", {
    conversationId: "19:thread@thread.tacv2",
    messageId: "123",
  }),
  withLabel("builds channel reply urls when replyToId is present", {
    messageId: "reply-id",
    replyToId: "root-id",
  }),
];
const GRAPH_URL_EXPECTATION_CASES: GraphUrlExpectationCase[] = [
  ...CHANNEL_GRAPH_URL_CASES.map<GraphUrlExpectationCase>(({ label, ...params }) =>
    withLabel(label, {
      params: createChannelGraphMessageUrlParams(params),
      expectedPath: buildExpectedChannelMessagePath(params),
    }),
  ),
  withLabel("builds chat message urls", {
    params: {
      conversationType: "groupChat" as const,
      conversationId: "19:chat@thread.v2",
      messageId: "456",
    },
    expectedPath: "/chats/19%3Achat%40thread.v2/messages/456",
  }),
];

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
type GraphEndpointResponseHandler = {
  suffix: string;
  buildResponse: () => Response;
};
const createGraphEndpointResponseHandlers = (params: {
  hostedContents: unknown[];
  attachments: unknown[];
  messageAttachments: unknown[];
}): GraphEndpointResponseHandler[] => [
  {
    suffix: "/hostedContents",
    buildResponse: () => createGraphCollectionResponse(params.hostedContents),
  },
  {
    suffix: "/attachments",
    buildResponse: () => createGraphCollectionResponse(params.attachments),
  },
  {
    suffix: "/messages/123",
    buildResponse: () => createJsonResponse({ attachments: params.messageAttachments }),
  },
];
const resolveGraphEndpointResponse = (
  url: string,
  handlers: GraphEndpointResponseHandler[],
): Response | undefined => {
  const handler = handlers.find((entry) => url.endsWith(entry.suffix));
  return handler ? handler.buildResponse() : undefined;
};

const createGraphFetchMock = (options: GraphFetchMockOptions = {}) => {
  const hostedContents = options.hostedContents ?? [];
  const attachments = options.attachments ?? [];
  const messageAttachments = options.messageAttachments ?? [];
  const endpointHandlers = createGraphEndpointResponseHandlers({
    hostedContents,
    attachments,
    messageAttachments,
  });
  return vi.fn(async (url: string) => {
    const endpointResponse = resolveGraphEndpointResponse(url, endpointHandlers);
    if (endpointResponse) {
      return endpointResponse;
    }
    if (url.startsWith(GRAPH_SHARES_URL_PREFIX) && options.onShareRequest) {
      return options.onShareRequest(url);
    }
    const unhandled = options.onUnhandled ? await options.onUnhandled(url) : undefined;
    return unhandled ?? createNotFoundResponse();
  });
};
const downloadGraphMediaWithMockOptions = async (
  options: GraphFetchMockOptions = {},
  overrides: DownloadGraphMediaOverrides = {},
): Promise<GraphMediaDownloadResult> => {
  const fetchMock = createGraphFetchMock(options);
  const media = await downloadMSTeamsGraphMedia({
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn: asFetchFn(fetchMock),
    ...overrides,
  });
  return { fetchMock, media };
};
const runAttachmentDownloadSuccessCase = async ({
  attachments,
  buildFetchFn,
  beforeDownload,
  assert,
}: AttachmentDownloadSuccessCase) => {
  const fetchFn = (buildFetchFn ?? (() => createOkFetchMock(CONTENT_TYPE_IMAGE_PNG)))();
  beforeDownload?.();
  const media = await downloadAttachmentsWithFetch(attachments, fetchFn);
  expectSingleMedia(media);
  assert?.(media);
};
const runAttachmentAuthRetryCase = async ({
  scenario,
  expectedMediaLength,
  expectTokenFetch,
}: AttachmentAuthRetryCase) => {
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
  expectAttachmentMediaLength(media, expectedMediaLength);
  expectMockCallState(tokenProvider.getAccessToken, expectTokenFetch);
};
const runGraphMediaSuccessCase = async ({
  buildOptions,
  expectedLength,
  assert,
}: GraphMediaSuccessCase) => {
  const { fetchMock, media } = await downloadGraphMediaWithMockOptions(buildOptions());
  expectAttachmentMediaLength(media.media, expectedLength);
  assert?.({ fetchMock, media });
};

describe("msteams attachments", () => {
  beforeEach(() => {
    detectMimeMock.mockClear();
    saveMediaBufferMock.mockClear();
    fetchRemoteMediaMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it.each<AttachmentPlaceholderCase>(ATTACHMENT_PLACEHOLDER_CASES)(
      "$label",
      ({ attachments, expected }) => {
        expect(buildMSTeamsAttachmentPlaceholder(attachments)).toBe(expected);
      },
    );
  });

  describe("downloadMSTeamsAttachments", () => {
    it.each<AttachmentDownloadSuccessCase>(ATTACHMENT_DOWNLOAD_SUCCESS_CASES)(
      "$label",
      runAttachmentDownloadSuccessCase,
    );

    it("stores inline data:image base64 payloads", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([`data:image/png;base64,${PNG_BASE64}`]),
        ]),
      );

      expectSingleMedia(media);
      expectMediaBufferSaved();
    });

    it.each<AttachmentAuthRetryCase>(ATTACHMENT_AUTH_RETRY_CASES)(
      "$label",
      runAttachmentAuthRetryCase,
    );

    it("skips urls outside the allowlist", async () => {
      const fetchMock = vi.fn();
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_OUTSIDE_ALLOWLIST),
        fetchMock,
        {
          allowHosts: [GRAPH_HOST],
          resolveFn: undefined,
        },
        { expectFetchCalled: false },
      );

      expectAttachmentMediaLength(media, 0);
    });
  });

  describe("buildMSTeamsGraphMessageUrls", () => {
    it.each(GRAPH_URL_EXPECTATION_CASES)("$label", ({ params, expectedPath }) => {
      const urls = buildMSTeamsGraphMessageUrls(params);
      expect(urls[0]).toContain(expectedPath);
    });
  });

  describe("downloadMSTeamsGraphMedia", () => {
    it.each<GraphMediaSuccessCase>(GRAPH_MEDIA_SUCCESS_CASES)("$label", runGraphMediaSuccessCase);

    it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
      const escapedUrl = "https://evil.example/internal.pdf";
      fetchRemoteMediaMock.mockImplementationOnce(async (params) => {
        const fetchFn = params.fetchImpl ?? fetch;
        let currentUrl = params.url;
        for (let i = 0; i < MAX_REDIRECT_HOPS; i += 1) {
          const res = await fetchFn(currentUrl, { redirect: "manual" });
          if (REDIRECT_STATUS_CODES.includes(res.status)) {
            const location = res.headers.get("location");
            if (!location) {
              throw new Error("redirect missing location");
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          return readRemoteMediaResponse(res, params);
        }
        throw new Error("too many redirects");
      });

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

      expectAttachmentMediaLength(media.media, 0);
      const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calledUrls.some((url) => url.startsWith(GRAPH_SHARES_URL_PREFIX))).toBe(true);
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
