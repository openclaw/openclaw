import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsGraphMessageUrls,
  buildMSTeamsMediaPayload,
  downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia
} from "./attachments.js";
import { setMSTeamsRuntime } from "./runtime.js";
const GRAPH_HOST = "graph.microsoft.com";
const SHAREPOINT_HOST = "contoso.sharepoint.com";
const AZUREEDGE_HOST = "azureedge.net";
const TEST_HOST = "x";
const createUrlForHost = (host, pathSegment) => `https://${host}/${pathSegment}`;
const createTestUrl = (pathSegment) => createUrlForHost(TEST_HOST, pathSegment);
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
const detectMimeMock = vi.fn(async () => CONTENT_TYPE_IMAGE_PNG);
const saveMediaBufferMock = vi.fn(async () => ({
  id: "saved.png",
  path: SAVED_PNG_PATH,
  size: Buffer.byteLength(PNG_BUFFER),
  contentType: CONTENT_TYPE_IMAGE_PNG
}));
const readRemoteMediaResponse = async (res, params) => {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
    throw new Error(`payload exceeds maxBytes ${params.maxBytes}`);
  }
  return {
    buffer,
    contentType: res.headers.get("content-type") ?? void 0,
    fileName: params.filePathHint
  };
};
function isHostnameAllowedByPattern(hostname, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return suffix.length > 0 && hostname !== suffix && hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}
function isUrlAllowedBySsrfPolicy(url, policy) {
  if (!policy?.hostnameAllowlist || policy.hostnameAllowlist.length === 0) {
    return true;
  }
  const hostname = new URL(url).hostname.toLowerCase();
  return policy.hostnameAllowlist.some(
    (pattern) => isHostnameAllowedByPattern(hostname, pattern.toLowerCase())
  );
}
async function fetchRemoteMediaWithRedirects(params, requestInit) {
  const fetchFn = params.fetchImpl ?? fetch;
  let currentUrl = params.url;
  for (let i = 0; i <= MAX_REDIRECT_HOPS; i += 1) {
    if (!isUrlAllowedBySsrfPolicy(currentUrl, params.ssrfPolicy)) {
      throw new Error(`Blocked hostname (not in allowlist): ${currentUrl}`);
    }
    const res = await fetchFn(currentUrl, { redirect: "manual", ...requestInit });
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
}
const fetchRemoteMediaMock = vi.fn(async (params) => {
  return await fetchRemoteMediaWithRedirects(params);
});
const runtimeStub = createPluginRuntimeMock({
  media: {
    detectMime: detectMimeMock
  },
  channel: {
    media: {
      fetchRemoteMedia: fetchRemoteMediaMock,
      saveMediaBuffer: saveMediaBufferMock
    }
  }
});
const DEFAULT_MESSAGE_URL = `https://${GRAPH_HOST}/v1.0/chats/19%3Achat/messages/123`;
const GRAPH_SHARES_URL_PREFIX = `https://${GRAPH_HOST}/v1.0/shares/`;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = [TEST_HOST];
const DEFAULT_SHAREPOINT_ALLOW_HOSTS = [GRAPH_HOST, SHAREPOINT_HOST];
const DEFAULT_SHARE_REFERENCE_URL = createUrlForHost(SHAREPOINT_HOST, "site/file");
const MEDIA_PLACEHOLDER_IMAGE = "<media:image>";
const MEDIA_PLACEHOLDER_DOCUMENT = "<media:document>";
const formatImagePlaceholder = (count) => count > 1 ? `${MEDIA_PLACEHOLDER_IMAGE} (${count} images)` : MEDIA_PLACEHOLDER_IMAGE;
const formatDocumentPlaceholder = (count) => count > 1 ? `${MEDIA_PLACEHOLDER_DOCUMENT} (${count} files)` : MEDIA_PLACEHOLDER_DOCUMENT;
const IMAGE_ATTACHMENT = { contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: TEST_URL_IMAGE };
const PNG_BUFFER = Buffer.from("png");
const PNG_BASE64 = PNG_BUFFER.toString("base64");
const PDF_BUFFER = Buffer.from("pdf");
const createTokenProvider = (tokenOrResolver = "token") => ({
  getAccessToken: vi.fn(
    async (scope) => typeof tokenOrResolver === "function" ? await tokenOrResolver(scope) : tokenOrResolver
  )
});
const asSingleItemArray = (value) => [value];
const withLabel = (label, fields) => ({
  label,
  ...fields
});
const buildAttachment = (contentType, props) => ({
  contentType,
  ...props
});
const createHtmlAttachment = (content) => buildAttachment(CONTENT_TYPE_TEXT_HTML, { content });
const buildHtmlImageTag = (src) => `<img src="${src}" />`;
const createHtmlImageAttachments = (sources, prefix = "") => asSingleItemArray(createHtmlAttachment(`${prefix}${sources.map(buildHtmlImageTag).join("")}`));
const createContentUrlAttachments = (contentType, ...contentUrls) => contentUrls.map((contentUrl) => buildAttachment(contentType, { contentUrl }));
const createImageAttachments = (...contentUrls) => createContentUrlAttachments(CONTENT_TYPE_IMAGE_PNG, ...contentUrls);
const createPdfAttachments = (...contentUrls) => createContentUrlAttachments(CONTENT_TYPE_APPLICATION_PDF, ...contentUrls);
const createTeamsFileDownloadInfoAttachments = (downloadUrl = TEST_URL_FILE_DOWNLOAD, fileType = "png") => asSingleItemArray(
  buildAttachment(CONTENT_TYPE_TEAMS_FILE_DOWNLOAD_INFO, {
    content: { downloadUrl, fileType }
  })
);
const createMediaEntriesWithType = (contentType, ...paths) => paths.map((path) => ({ path, contentType }));
const createHostedContentsWithType = (contentType, ...ids) => ids.map((id) => ({ id, contentType, contentBytes: PNG_BASE64 }));
const createImageMediaEntries = (...paths) => createMediaEntriesWithType(CONTENT_TYPE_IMAGE_PNG, ...paths);
const createHostedImageContents = (...ids) => createHostedContentsWithType(CONTENT_TYPE_IMAGE_PNG, ...ids);
const createPdfResponse = (payload = PDF_BUFFER) => {
  return createBufferResponse(payload, CONTENT_TYPE_APPLICATION_PDF);
};
const createBufferResponse = (payload, contentType, status = 200) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Response(new Uint8Array(raw), {
    status,
    headers: { "content-type": contentType }
  });
};
const createJsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const createTextResponse = (body, status = 200) => new Response(body, { status });
const createGraphCollectionResponse = (value) => createJsonResponse({ value });
const createNotFoundResponse = () => new Response("not found", { status: 404 });
const createRedirectResponse = (location, status = 302) => new Response(null, { status, headers: { location } });
const createOkFetchMock = (contentType, payload = "png") => vi.fn(async () => createBufferResponse(payload, contentType));
const asFetchFn = (fetchFn) => fetchFn;
const buildDownloadParams = (attachments, overrides = {}) => {
  return {
    attachments,
    maxBytes: DEFAULT_MAX_BYTES,
    allowHosts: DEFAULT_ALLOW_HOSTS,
    ...overrides
  };
};
const downloadAttachmentsWithFetch = async (attachments, fetchFn, overrides = {}, options = {}) => {
  const media = await downloadMSTeamsAttachments(
    buildDownloadParams(attachments, {
      ...overrides,
      fetchFn: asFetchFn(fetchFn)
    })
  );
  expectMockCallState(fetchFn, options.expectFetchCalled ?? true);
  return media;
};
const createAuthAwareImageFetchMock = (params) => vi.fn(async (_url, opts) => {
  const headers = new Headers(opts?.headers);
  const hasAuth = Boolean(headers.get("Authorization"));
  if (!hasAuth) {
    return createTextResponse(params.unauthBody, params.unauthStatus);
  }
  return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
});
const expectMockCallState = (mockFn, shouldCall) => {
  if (shouldCall) {
    expect(mockFn).toHaveBeenCalled();
  } else {
    expect(mockFn).not.toHaveBeenCalled();
  }
};
const DEFAULT_CHANNEL_TEAM_ID = "team-id";
const DEFAULT_CHANNEL_ID = "chan-id";
const createChannelGraphMessageUrlParams = (params) => ({
  conversationType: "channel",
  ...params,
  channelData: {
    team: { id: DEFAULT_CHANNEL_TEAM_ID },
    channel: { id: DEFAULT_CHANNEL_ID }
  }
});
const buildExpectedChannelMessagePath = (params) => params.replyToId ? `/teams/${DEFAULT_CHANNEL_TEAM_ID}/channels/${DEFAULT_CHANNEL_ID}/messages/${params.replyToId}/replies/${params.messageId}` : `/teams/${DEFAULT_CHANNEL_TEAM_ID}/channels/${DEFAULT_CHANNEL_ID}/messages/${params.messageId}`;
const expectAttachmentMediaLength = (media, expectedLength) => {
  expect(media).toHaveLength(expectedLength);
};
const expectSingleMedia = (media, expected = {}) => {
  expectAttachmentMediaLength(media, 1);
  expectFirstMedia(media, expected);
};
const expectMediaBufferSaved = () => {
  expect(saveMediaBufferMock).toHaveBeenCalled();
};
const expectFirstMedia = (media, expected) => {
  const first = media[0];
  if (expected.path !== void 0) {
    expect(first?.path).toBe(expected.path);
  }
  if (expected.placeholder !== void 0) {
    expect(first?.placeholder).toBe(expected.placeholder);
  }
};
const expectMSTeamsMediaPayload = (payload, expected) => {
  expect(payload.MediaPath).toBe(expected.firstPath);
  expect(payload.MediaUrl).toBe(expected.firstPath);
  expect(payload.MediaPaths).toEqual(expected.paths);
  expect(payload.MediaUrls).toEqual(expected.paths);
  expect(payload.MediaTypes).toEqual(expected.types);
};
const EMPTY_ATTACHMENT_PLACEHOLDER_CASES = [
  withLabel("returns empty string when no attachments", { attachments: void 0, expected: "" }),
  withLabel("returns empty string when attachments are empty", { attachments: [], expected: "" })
];
const COUNTED_ATTACHMENT_PLACEHOLDER_CASE_DEFS = [
  withLabel("returns image placeholder for one image attachment", {
    attachments: createImageAttachments(TEST_URL_IMAGE_PNG),
    count: 1,
    formatPlaceholder: formatImagePlaceholder
  }),
  withLabel("returns image placeholder with count for many image attachments", {
    attachments: [
      ...createImageAttachments(TEST_URL_IMAGE_1_PNG),
      { contentType: "image/jpeg", contentUrl: TEST_URL_IMAGE_2_JPG }
    ],
    count: 2,
    formatPlaceholder: formatImagePlaceholder
  }),
  withLabel("treats Teams file.download.info image attachments as images", {
    attachments: createTeamsFileDownloadInfoAttachments(),
    count: 1,
    formatPlaceholder: formatImagePlaceholder
  }),
  withLabel("returns document placeholder for non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF),
    count: 1,
    formatPlaceholder: formatDocumentPlaceholder
  }),
  withLabel("returns document placeholder with count for many non-image attachments", {
    attachments: createPdfAttachments(TEST_URL_PDF_1, TEST_URL_PDF_2),
    count: 2,
    formatPlaceholder: formatDocumentPlaceholder
  }),
  withLabel("counts one inline image in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A], "<p>hi</p>"),
    count: 1,
    formatPlaceholder: formatImagePlaceholder
  }),
  withLabel("counts many inline images in html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_HTML_A, TEST_URL_HTML_B]),
    count: 2,
    formatPlaceholder: formatImagePlaceholder
  })
];
const ATTACHMENT_PLACEHOLDER_CASES = [
  ...EMPTY_ATTACHMENT_PLACEHOLDER_CASES,
  ...COUNTED_ATTACHMENT_PLACEHOLDER_CASE_DEFS.map(
    (testCase) => withLabel(testCase.label, {
      attachments: testCase.attachments,
      expected: testCase.formatPlaceholder(testCase.count)
    })
  )
];
const ATTACHMENT_DOWNLOAD_SUCCESS_CASES = [
  withLabel("downloads and stores image contentUrl attachments", {
    attachments: asSingleItemArray(IMAGE_ATTACHMENT),
    assert: (media) => {
      expectFirstMedia(media, { path: SAVED_PNG_PATH });
      expectMediaBufferSaved();
    }
  }),
  withLabel("supports Teams file.download.info downloadUrl attachments", {
    attachments: createTeamsFileDownloadInfoAttachments()
  }),
  withLabel("downloads inline image URLs from html attachments", {
    attachments: createHtmlImageAttachments([TEST_URL_INLINE_IMAGE])
  }),
  withLabel("downloads non-image file attachments (PDF)", {
    attachments: createPdfAttachments(TEST_URL_DOC_PDF),
    buildFetchFn: () => createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf"),
    beforeDownload: () => {
      detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
      saveMediaBufferMock.mockResolvedValueOnce({
        id: "saved.pdf",
        path: SAVED_PDF_PATH,
        size: Buffer.byteLength(PDF_BUFFER),
        contentType: CONTENT_TYPE_APPLICATION_PDF
      });
    },
    assert: (media) => {
      expectSingleMedia(media, {
        path: SAVED_PDF_PATH,
        placeholder: formatDocumentPlaceholder(1)
      });
    }
  })
];
const ATTACHMENT_AUTH_RETRY_CASES = [
  withLabel("retries with auth when the first request is unauthorized", {
    scenario: {
      attachmentUrl: IMAGE_ATTACHMENT.contentUrl,
      unauthStatus: 401,
      unauthBody: "unauthorized",
      overrides: { authAllowHosts: [TEST_HOST] }
    },
    expectedMediaLength: 1,
    expectTokenFetch: true
  }),
  withLabel("skips auth retries when the host is not in auth allowlist", {
    scenario: {
      attachmentUrl: createUrlForHost(AZUREEDGE_HOST, "img"),
      unauthStatus: 403,
      unauthBody: "forbidden",
      overrides: {
        allowHosts: [AZUREEDGE_HOST],
        authAllowHosts: [GRAPH_HOST]
      }
    },
    expectedMediaLength: 0,
    expectTokenFetch: false
  })
];
const GRAPH_MEDIA_SUCCESS_CASES = [
  withLabel("downloads hostedContents images", {
    buildOptions: () => ({ hostedContents: createHostedImageContents("1") }),
    expectedLength: 1,
    assert: ({ fetchMock }) => {
      expect(fetchMock).toHaveBeenCalled();
      expectMediaBufferSaved();
    }
  }),
  withLabel("merges SharePoint reference attachments with hosted content", {
    buildOptions: () => {
      return {
        hostedContents: createHostedImageContents("hosted-1"),
        ...buildDefaultShareReferenceGraphFetchOptions({
          onShareRequest: () => createPdfResponse()
        })
      };
    },
    expectedLength: 2
  })
];
const CHANNEL_GRAPH_URL_CASES = [
  withLabel("builds channel message urls", {
    conversationId: "19:thread@thread.tacv2",
    messageId: "123"
  }),
  withLabel("builds channel reply urls when replyToId is present", {
    messageId: "reply-id",
    replyToId: "root-id"
  })
];
const GRAPH_URL_EXPECTATION_CASES = [
  ...CHANNEL_GRAPH_URL_CASES.map(
    ({ label, ...params }) => withLabel(label, {
      params: createChannelGraphMessageUrlParams(params),
      expectedPath: buildExpectedChannelMessagePath(params)
    })
  ),
  withLabel("builds chat message urls", {
    params: {
      conversationType: "groupChat",
      conversationId: "19:chat@thread.v2",
      messageId: "456"
    },
    expectedPath: "/chats/19%3Achat%40thread.v2/messages/456"
  })
];
const createReferenceAttachment = (shareUrl = DEFAULT_SHARE_REFERENCE_URL) => ({
  id: "ref-1",
  contentType: "reference",
  contentUrl: shareUrl,
  name: "report.pdf"
});
const buildShareReferenceGraphFetchOptions = (params) => ({
  attachments: [params.referenceAttachment],
  messageAttachments: [params.referenceAttachment],
  ...params.onShareRequest ? { onShareRequest: params.onShareRequest } : {},
  ...params.onUnhandled ? { onUnhandled: params.onUnhandled } : {}
});
const buildDefaultShareReferenceGraphFetchOptions = (params) => buildShareReferenceGraphFetchOptions({
  referenceAttachment: createReferenceAttachment(),
  ...params
});
const createGraphEndpointResponseHandlers = (params) => [
  {
    suffix: "/hostedContents",
    buildResponse: () => createGraphCollectionResponse(params.hostedContents)
  },
  {
    suffix: "/attachments",
    buildResponse: () => createGraphCollectionResponse(params.attachments)
  },
  {
    suffix: "/messages/123",
    buildResponse: () => createJsonResponse({ attachments: params.messageAttachments })
  }
];
const resolveGraphEndpointResponse = (url, handlers) => {
  const handler = handlers.find((entry) => url.endsWith(entry.suffix));
  return handler ? handler.buildResponse() : void 0;
};
const createGraphFetchMock = (options = {}) => {
  const hostedContents = options.hostedContents ?? [];
  const attachments = options.attachments ?? [];
  const messageAttachments = options.messageAttachments ?? [];
  const endpointHandlers = createGraphEndpointResponseHandlers({
    hostedContents,
    attachments,
    messageAttachments
  });
  return vi.fn(async (url) => {
    const endpointResponse = resolveGraphEndpointResponse(url, endpointHandlers);
    if (endpointResponse) {
      return endpointResponse;
    }
    if (url.startsWith(GRAPH_SHARES_URL_PREFIX) && options.onShareRequest) {
      return options.onShareRequest(url);
    }
    const unhandled = options.onUnhandled ? await options.onUnhandled(url) : void 0;
    return unhandled ?? createNotFoundResponse();
  });
};
const downloadGraphMediaWithMockOptions = async (options = {}, overrides = {}) => {
  const fetchMock = createGraphFetchMock(options);
  const media = await downloadMSTeamsGraphMedia({
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn: asFetchFn(fetchMock),
    ...overrides
  });
  return { fetchMock, media };
};
const runAttachmentDownloadSuccessCase = async ({
  attachments,
  buildFetchFn,
  beforeDownload,
  assert
}) => {
  const fetchFn = (buildFetchFn ?? (() => createOkFetchMock(CONTENT_TYPE_IMAGE_PNG)))();
  beforeDownload?.();
  const media = await downloadAttachmentsWithFetch(attachments, fetchFn);
  expectSingleMedia(media);
  assert?.(media);
};
const runAttachmentAuthRetryCase = async ({
  scenario,
  expectedMediaLength,
  expectTokenFetch
}) => {
  const tokenProvider = createTokenProvider();
  const fetchMock = createAuthAwareImageFetchMock({
    unauthStatus: scenario.unauthStatus,
    unauthBody: scenario.unauthBody
  });
  const media = await downloadAttachmentsWithFetch(
    createImageAttachments(scenario.attachmentUrl),
    fetchMock,
    { tokenProvider, ...scenario.overrides }
  );
  expectAttachmentMediaLength(media, expectedMediaLength);
  expectMockCallState(tokenProvider.getAccessToken, expectTokenFetch);
};
const runGraphMediaSuccessCase = async ({
  buildOptions,
  expectedLength,
  assert
}) => {
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
    it.each(ATTACHMENT_PLACEHOLDER_CASES)(
      "$label",
      ({ attachments, expected }) => {
        expect(buildMSTeamsAttachmentPlaceholder(attachments)).toBe(expected);
      }
    );
  });
  describe("downloadMSTeamsAttachments", () => {
    it.each(ATTACHMENT_DOWNLOAD_SUCCESS_CASES)(
      "$label",
      runAttachmentDownloadSuccessCase
    );
    it("stores inline data:image base64 payloads", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          ...createHtmlImageAttachments([`data:image/png;base64,${PNG_BASE64}`])
        ])
      );
      expectSingleMedia(media);
      expectMediaBufferSaved();
    });
    it.each(ATTACHMENT_AUTH_RETRY_CASES)(
      "$label",
      runAttachmentAuthRetryCase
    );
    it("preserves auth fallback when dispatcher-mode fetch returns a redirect", async () => {
      const redirectedUrl = createTestUrl("redirected.png");
      const tokenProvider = createTokenProvider();
      const fetchMock = vi.fn(async (url, opts) => {
        const hasAuth = Boolean(new Headers(opts?.headers).get("Authorization"));
        if (url === TEST_URL_IMAGE) {
          return hasAuth ? createRedirectResponse(redirectedUrl) : createTextResponse("unauthorized", 401);
        }
        if (url === redirectedUrl) {
          return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
        }
        return createNotFoundResponse();
      });
      fetchRemoteMediaMock.mockImplementationOnce(async (params) => {
        return await fetchRemoteMediaWithRedirects(params, {
          dispatcher: {}
        });
      });
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        { tokenProvider, authAllowHosts: [TEST_HOST] }
      );
      expectAttachmentMediaLength(media, 1);
      expect(tokenProvider.getAccessToken).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls.map(([calledUrl]) => String(calledUrl))).toContain(redirectedUrl);
    });
    it("continues scope fallback after non-auth failure and succeeds on later scope", async () => {
      let authAttempt = 0;
      const tokenProvider = createTokenProvider((scope) => `token:${scope}`);
      const fetchMock = vi.fn(async (_url, opts) => {
        const auth = new Headers(opts?.headers).get("Authorization");
        if (!auth) {
          return createTextResponse("unauthorized", 401);
        }
        authAttempt += 1;
        if (authAttempt === 1) {
          return createTextResponse("upstream transient", 500);
        }
        return createBufferResponse(PNG_BUFFER, CONTENT_TYPE_IMAGE_PNG);
      });
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        { tokenProvider, authAllowHosts: [TEST_HOST] }
      );
      expectAttachmentMediaLength(media, 1);
      expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    });
    it("does not forward Authorization to redirects outside auth allowlist", async () => {
      const tokenProvider = createTokenProvider("top-secret-token");
      const graphFileUrl = createUrlForHost(GRAPH_HOST, "file");
      const seen = [];
      const fetchMock = vi.fn(async (url, opts) => {
        const auth = new Headers(opts?.headers).get("Authorization") ?? "";
        seen.push({ url, auth });
        if (url === graphFileUrl && !auth) {
          return new Response("unauthorized", { status: 401 });
        }
        if (url === graphFileUrl && auth) {
          return new Response("", {
            status: 302,
            headers: { location: "https://attacker.azureedge.net/collect" }
          });
        }
        if (url === "https://attacker.azureedge.net/collect") {
          return new Response(Buffer.from("png"), {
            status: 200,
            headers: { "content-type": CONTENT_TYPE_IMAGE_PNG }
          });
        }
        return createNotFoundResponse();
      });
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: CONTENT_TYPE_IMAGE_PNG, contentUrl: graphFileUrl }], {
          tokenProvider,
          allowHosts: [GRAPH_HOST, AZUREEDGE_HOST],
          authAllowHosts: [GRAPH_HOST],
          fetchFn: asFetchFn(fetchMock)
        })
      );
      expectSingleMedia(media);
      const redirected = seen.find(
        (entry) => entry.url === "https://attacker.azureedge.net/collect"
      );
      expect(redirected).toBeDefined();
      expect(redirected?.auth).toBe("");
    });
    it("skips urls outside the allowlist", async () => {
      const fetchMock = vi.fn();
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_OUTSIDE_ALLOWLIST),
        fetchMock,
        {
          allowHosts: [GRAPH_HOST]
        },
        { expectFetchCalled: false }
      );
      expectAttachmentMediaLength(media, 0);
    });
    it("blocks redirects to non-https URLs", async () => {
      const insecureUrl = "http://x/insecure.png";
      const fetchMock = vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === TEST_URL_IMAGE) {
          return createRedirectResponse(insecureUrl);
        }
        if (url === insecureUrl) {
          return createBufferResponse("insecure", CONTENT_TYPE_IMAGE_PNG);
        }
        return createNotFoundResponse();
      });
      const media = await downloadAttachmentsWithFetch(
        createImageAttachments(TEST_URL_IMAGE),
        fetchMock,
        {
          allowHosts: [TEST_HOST]
        }
      );
      expectAttachmentMediaLength(media, 0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
  describe("buildMSTeamsGraphMessageUrls", () => {
    it.each(GRAPH_URL_EXPECTATION_CASES)("$label", ({ params, expectedPath }) => {
      const urls = buildMSTeamsGraphMessageUrls(params);
      expect(urls[0]).toContain(expectedPath);
    });
  });
  describe("downloadMSTeamsGraphMedia", () => {
    it.each(GRAPH_MEDIA_SUCCESS_CASES)("$label", runGraphMediaSuccessCase);
    it("does not forward Authorization for SharePoint redirects outside auth allowlist", async () => {
      const tokenProvider = createTokenProvider("top-secret-token");
      const escapedUrl = "https://example.com/collect";
      const seen = [];
      const referenceAttachment = createReferenceAttachment();
      const fetchMock = vi.fn(async (input, init) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        seen.push({ url, auth });
        if (url === DEFAULT_MESSAGE_URL) {
          return createJsonResponse({ attachments: [referenceAttachment] });
        }
        if (url === `${DEFAULT_MESSAGE_URL}/hostedContents`) {
          return createGraphCollectionResponse([]);
        }
        if (url === `${DEFAULT_MESSAGE_URL}/attachments`) {
          return createGraphCollectionResponse([referenceAttachment]);
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
        fetchFn: asFetchFn(fetchMock)
      });
      expectAttachmentMediaLength(media.media, 1);
      const redirected = seen.find((entry) => entry.url === escapedUrl);
      expect(redirected).toBeDefined();
      expect(redirected?.auth).toBe("");
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
              return void 0;
            }
          })
        },
        {
          allowHosts: DEFAULT_SHAREPOINT_ALLOW_HOSTS
        }
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
        types: [CONTENT_TYPE_IMAGE_PNG, CONTENT_TYPE_IMAGE_PNG]
      });
    });
  });
});
