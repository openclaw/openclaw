// Msteams tests cover attachments.graph plugin behavior.
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import type { PluginRuntime } from "../runtime-api.js";
import { readRemoteMediaResponse } from "./attachments.test-helpers.js";
import { downloadMSTeamsGraphMedia } from "./attachments/graph.js";
import { encodeGraphShareId, resolveRequestUrl } from "./attachments/shared.js";
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
const readRemoteMediaBufferMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    filePathHint?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url, { redirect: "manual" });
    return readRemoteMediaResponse(res, params);
  },
);
const saveRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    filePathHint?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetched = await readRemoteMediaBufferMock(params);
    return await saveMediaBufferMock(
      fetched.buffer,
      fetched.contentType,
      "inbound",
      params.maxBytes,
      params.filePathHint,
    );
  },
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
      readRemoteMediaBuffer: readRemoteMediaBufferMock,
      saveRemoteMedia: saveRemoteMediaMock,
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
    readRemoteMediaBufferMock.mockClear();
    saveRemoteMediaMock.mockClear();
    saveResponseMediaMock.mockClear();
    saveMediaBufferMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  it("streams non-image hosted content through the response saver", async () => {
    const { media } = await downloadGraphMediaWithMockOptions({
      hostedContents: [{ id: "hosted-1", contentType: CONTENT_TYPE_APPLICATION_PDF }],
      onUnhandled: (url) =>
        url.endsWith("/hostedContents/hosted-1/$value") ? createPdfResponse() : undefined,
    });
    expect(media.media).toHaveLength(1);
    expect(saveResponseMediaMock).toHaveBeenCalledOnce();
    expect(saveMediaBufferMock).toHaveBeenCalled();
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
