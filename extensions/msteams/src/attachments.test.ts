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

const detectMimeMock = vi.fn(async () => "image/png");
const saveMediaBufferMock = vi.fn(async () => ({
  path: "/tmp/saved.png",
  contentType: "image/png",
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

const DEFAULT_MESSAGE_URL = "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = ["x"];
const IMAGE_ATTACHMENT = { contentType: "image/png", contentUrl: "https://x/img" };
const PNG_BUFFER = Buffer.from("png");
const PNG_BASE64 = PNG_BUFFER.toString("base64");
const PDF_BUFFER = Buffer.from("pdf");
const createTokenProvider = () => ({ getAccessToken: vi.fn(async () => "token") });
const buildAttachment = <T extends Record<string, unknown>>(contentType: string, props: T) => ({
  contentType,
  ...props,
});
const createHtmlAttachment = (content: string) => buildAttachment("text/html", { content });
const createImageAttachment = (contentUrl: string) => buildAttachment("image/png", { contentUrl });
const createPdfAttachment = (contentUrl: string) =>
  buildAttachment("application/pdf", { contentUrl });
const createTeamsFileDownloadInfoAttachment = (downloadUrl = "https://x/dl", fileType = "png") =>
  buildAttachment("application/vnd.microsoft.teams.file.download.info", {
    content: { downloadUrl, fileType },
  });
const createImageMediaEntry = (path: string) => ({ path, contentType: "image/png" });
const createHostedImageContent = (id: string) => ({
  id,
  contentType: "image/png",
  contentBytes: PNG_BASE64,
});

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
  options: { expectFetchCalled?: boolean } = {},
) => {
  const media = await downloadMSTeamsAttachments(
    buildDownloadParamsWithFetch(attachments, fetchFn, overrides),
  );
  if (options.expectFetchCalled ?? true) {
    expect(fetchFn).toHaveBeenCalled();
  } else {
    expect(fetchFn).not.toHaveBeenCalled();
  }
  return media;
};
const downloadAttachmentsWithOkImageFetch = (
  attachments: DownloadAttachmentsParams["attachments"],
  overrides: DownloadAttachmentsNoFetchOverrides = {},
  options: { expectFetchCalled?: boolean } = {},
) => {
  return downloadAttachmentsWithFetch(
    attachments,
    createOkFetchMock("image/png"),
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
      headers: { "content-type": "image/png" },
    });
  });

const buildDownloadGraphParams = (
  fetchFn: unknown,
  overrides: Partial<
    Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider" | "maxBytes">
  > = {},
): DownloadGraphMediaParams => {
  return {
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: createTokenProvider(),
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  };
};

const downloadGraphMediaWithFetch = (
  fetchFn: unknown,
  overrides: Partial<
    Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider" | "maxBytes">
  > = {},
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

type GraphFetchMockOptions = {
  hostedContents?: unknown[];
  attachments?: unknown[];
  messageAttachments?: unknown[];
  onShareRequest?: (url: string) => Response | Promise<Response>;
  onUnhandled?: (url: string) => Response | Promise<Response> | undefined;
};

const createReferenceAttachment = (shareUrl: string) => ({
  id: "ref-1",
  contentType: "reference",
  contentUrl: shareUrl,
  name: "report.pdf",
});
const createShareReferenceFixture = (shareUrl = "https://contoso.sharepoint.com/site/file") => ({
  shareUrl,
  referenceAttachment: createReferenceAttachment(shareUrl),
});

const createGraphFetchMock = (options: GraphFetchMockOptions = {}) => {
  const hostedContents = options.hostedContents ?? [];
  const attachments = options.attachments ?? [];
  const messageAttachments = options.messageAttachments ?? [];
  return vi.fn(async (url: string) => {
    if (url.endsWith("/hostedContents")) {
      return new Response(JSON.stringify({ value: hostedContents }), { status: 200 });
    }
    if (url.endsWith("/attachments")) {
      return new Response(JSON.stringify({ value: attachments }), { status: 200 });
    }
    if (url.endsWith("/messages/123")) {
      return new Response(JSON.stringify({ attachments: messageAttachments }), { status: 200 });
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
  overrides: Partial<
    Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider" | "maxBytes">
  > = {},
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
    [createImageAttachment(scenario.attachmentUrl)],
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
        attachments: [createImageAttachment("https://x/img.png")],
        expected: "<media:image>",
      },
      {
        label: "returns image placeholder with count for many image attachments",
        attachments: [
          createImageAttachment("https://x/1.png"),
          { contentType: "image/jpeg", contentUrl: "https://x/2.jpg" },
        ],
        expected: "<media:image> (2 images)",
      },
      {
        label: "treats Teams file.download.info image attachments as images",
        attachments: [createTeamsFileDownloadInfoAttachment()],
        expected: "<media:image>",
      },
      {
        label: "returns document placeholder for non-image attachments",
        attachments: [createPdfAttachment("https://x/x.pdf")],
        expected: "<media:document>",
      },
      {
        label: "returns document placeholder with count for many non-image attachments",
        attachments: [
          createPdfAttachment("https://x/1.pdf"),
          createPdfAttachment("https://x/2.pdf"),
        ],
        expected: "<media:document> (2 files)",
      },
      {
        label: "counts one inline image in html attachments",
        attachments: [createHtmlAttachment('<p>hi</p><img src="https://x/a.png" />')],
        expected: "<media:image>",
      },
      {
        label: "counts many inline images in html attachments",
        attachments: [
          createHtmlAttachment('<img src="https://x/a.png" /><img src="https://x/b.png" />'),
        ],
        expected: "<media:image> (2 images)",
      },
    ])("$label", ({ attachments, expected }) => {
      expectAttachmentPlaceholder(attachments, expected);
    });
  });

  describe("downloadMSTeamsAttachments", () => {
    it.each<AttachmentDownloadSuccessCase>([
      {
        label: "downloads and stores image contentUrl attachments",
        attachments: [IMAGE_ATTACHMENT],
        assert: (media) => {
          expect(saveMediaBufferMock).toHaveBeenCalled();
          expect(media[0]?.path).toBe("/tmp/saved.png");
        },
      },
      {
        label: "supports Teams file.download.info downloadUrl attachments",
        attachments: [createTeamsFileDownloadInfoAttachment()],
      },
      {
        label: "downloads inline image URLs from html attachments",
        attachments: [createHtmlAttachment('<img src="https://x/inline.png" />')],
      },
    ])("$label", async ({ attachments, assert }) => {
      const media = await downloadAttachmentsWithOkImageFetch(attachments);
      expect(media).toHaveLength(1);
      assert?.(media);
    });

    it("downloads non-image file attachments (PDF)", async () => {
      const fetchMock = createOkFetchMock("application/pdf", "pdf");
      detectMimeMock.mockResolvedValueOnce("application/pdf");
      saveMediaBufferMock.mockResolvedValueOnce({
        path: "/tmp/saved.pdf",
        contentType: "application/pdf",
      });

      const media = await downloadAttachmentsWithFetch(
        [createPdfAttachment("https://x/doc.pdf")],
        fetchMock,
      );

      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.pdf");
      expect(media[0]?.placeholder).toBe("<media:document>");
    });

    it("stores inline data:image base64 payloads", async () => {
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          createHtmlAttachment(`<img src="data:image/png;base64,${PNG_BASE64}" />`),
        ]),
      );

      expect(media).toHaveLength(1);
      expect(saveMediaBufferMock).toHaveBeenCalled();
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
      expect(media).toHaveLength(expectedMediaLength);
      if (expectTokenFetch) {
        expect(tokenProvider.getAccessToken).toHaveBeenCalled();
      } else {
        expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
      }
    });

    it("skips urls outside the allowlist", async () => {
      const fetchMock = vi.fn();
      const media = await downloadAttachmentsWithFetch(
        [createImageAttachment("https://evil.test/img")],
        fetchMock,
        {
          allowHosts: ["graph.microsoft.com"],
          resolveFn: undefined,
        },
        { expectFetchCalled: false },
      );

      expect(media).toHaveLength(0);
    });
  });

  describe("buildMSTeamsGraphMessageUrls", () => {
    const cases: GraphUrlExpectationCase[] = [
      {
        label: "builds channel message urls",
        params: {
          conversationType: "channel" as const,
          conversationId: "19:thread@thread.tacv2",
          messageId: "123",
          channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
        },
        expectedPath: "/teams/team-id/channels/chan-id/messages/123",
      },
      {
        label: "builds channel reply urls when replyToId is present",
        params: {
          conversationType: "channel" as const,
          messageId: "reply-id",
          replyToId: "root-id",
          channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
        },
        expectedPath: "/teams/team-id/channels/chan-id/messages/root-id/replies/reply-id",
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
    it("downloads hostedContents images", async () => {
      const { fetchMock, media } = await downloadGraphMediaWithMockOptions({
        hostedContents: [createHostedImageContent("1")],
      });

      expect(media.media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalled();
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("merges SharePoint reference attachments with hosted content", async () => {
      const { referenceAttachment } = createShareReferenceFixture();
      const { media } = await downloadGraphMediaWithMockOptions({
        hostedContents: [createHostedImageContent("hosted-1")],
        attachments: [referenceAttachment],
        messageAttachments: [referenceAttachment],
        onShareRequest: () =>
          new Response(PDF_BUFFER, {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      });

      expect(media.media).toHaveLength(2);
    });

    it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
      const { referenceAttachment } = createShareReferenceFixture();
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
          messageAttachments: [referenceAttachment],
          onShareRequest: () =>
            new Response(null, {
              status: 302,
              headers: { location: escapedUrl },
            }),
          onUnhandled: (url) => {
            if (url === escapedUrl) {
              return new Response(Buffer.from("should-not-be-fetched"), {
                status: 200,
                headers: { "content-type": "application/pdf" },
              });
            }
            return undefined;
          },
        },
        {
          allowHosts: ["graph.microsoft.com", "contoso.sharepoint.com"],
        },
      );

      expect(media.media).toHaveLength(0);
      const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        calledUrls.some((url) => url.startsWith("https://graph.microsoft.com/v1.0/shares/")),
      ).toBe(true);
      expect(calledUrls).not.toContain(escapedUrl);
    });
  });

  describe("buildMSTeamsMediaPayload", () => {
    it("returns single and multi-file fields", async () => {
      const payload = buildMSTeamsMediaPayload([
        createImageMediaEntry("/tmp/a.png"),
        createImageMediaEntry("/tmp/b.png"),
      ]);
      expect(payload.MediaPath).toBe("/tmp/a.png");
      expect(payload.MediaUrl).toBe("/tmp/a.png");
      expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    });
  });
});
