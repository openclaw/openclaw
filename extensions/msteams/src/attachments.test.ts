import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";

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

type AttachmentsModule = typeof import("./attachments.js");
type DownloadAttachmentsParams = Parameters<AttachmentsModule["downloadMSTeamsAttachments"]>[0];
type DownloadGraphMediaParams = Parameters<AttachmentsModule["downloadMSTeamsGraphMedia"]>[0];

const DEFAULT_MESSAGE_URL = "https://graph.microsoft.com/v1.0/chats/19%3Achat/messages/123";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_HOSTS = ["x"];

const createOkFetchMock = (contentType: string, payload = "png") =>
  vi.fn(async () => {
    return new Response(Buffer.from(payload), {
      status: 200,
      headers: { "content-type": contentType },
    });
  });

const buildDownloadParams = (
  attachments: DownloadAttachmentsParams["attachments"],
  overrides: Partial<
    Omit<DownloadAttachmentsParams, "attachments" | "maxBytes" | "allowHosts" | "resolveFn">
  > &
    Pick<DownloadAttachmentsParams, "allowHosts" | "resolveFn"> = {},
): DownloadAttachmentsParams => {
  return {
    attachments,
    maxBytes: DEFAULT_MAX_BYTES,
    allowHosts: DEFAULT_ALLOW_HOSTS,
    resolveFn: publicResolveFn,
    ...overrides,
  };
};

const buildDownloadGraphParams = (
  fetchFn: typeof fetch,
  overrides: Partial<
    Omit<DownloadGraphMediaParams, "messageUrl" | "tokenProvider" | "maxBytes">
  > = {},
): DownloadGraphMediaParams => {
  return {
    messageUrl: DEFAULT_MESSAGE_URL,
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    maxBytes: DEFAULT_MAX_BYTES,
    fetchFn,
    ...overrides,
  };
};

describe("msteams attachments", () => {
  const load = async () => {
    return await import("./attachments.js");
  };

  beforeEach(() => {
    detectMimeMock.mockClear();
    saveMediaBufferMock.mockClear();
    fetchRemoteMediaMock.mockClear();
    setMSTeamsRuntime(runtimeStub);
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it("returns empty string when no attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(buildMSTeamsAttachmentPlaceholder(undefined)).toBe("");
      expect(buildMSTeamsAttachmentPlaceholder([])).toBe("");
    });

    it("returns image placeholder for image attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/img.png" },
        ]),
      ).toBe("<media:image>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/1.png" },
          { contentType: "image/jpeg", contentUrl: "https://x/2.jpg" },
        ]),
      ).toBe("<media:image> (2 images)");
    });

    it("treats Teams file.download.info image attachments as images", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x/dl", fileType: "png" },
          },
        ]),
      ).toBe("<media:image>");
    });

    it("returns document placeholder for non-image attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/x.pdf" },
        ]),
      ).toBe("<media:document>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/1.pdf" },
          { contentType: "application/pdf", contentUrl: "https://x/2.pdf" },
        ]),
      ).toBe("<media:document> (2 files)");
    });

    it("counts inline images in text/html attachments", async () => {
      const { buildMSTeamsAttachmentPlaceholder } = await load();
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "text/html",
            content: '<p>hi</p><img src="https://x/a.png" />',
          },
        ]),
      ).toBe("<media:image>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "text/html",
            content: '<img src="https://x/a.png" /><img src="https://x/b.png" />',
          },
        ]),
      ).toBe("<media:image> (2 images)");
    });
  });

  describe("downloadMSTeamsAttachments", () => {
    it("downloads and stores image contentUrl attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = createOkFetchMock("image/png");
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: "image/png", contentUrl: "https://x/img" }], {
          fetchFn: fetchMock as unknown as typeof fetch,
        }),
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(saveMediaBufferMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.png");
    });

    it("supports Teams file.download.info downloadUrl attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = createOkFetchMock("image/png");
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams(
          [
            {
              contentType: "application/vnd.microsoft.teams.file.download.info",
              content: { downloadUrl: "https://x/dl", fileType: "png" },
            },
          ],
          { fetchFn: fetchMock as unknown as typeof fetch },
        ),
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
    });

    it("downloads non-image file attachments (PDF)", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = createOkFetchMock("application/pdf", "pdf");
      detectMimeMock.mockResolvedValueOnce("application/pdf");
      saveMediaBufferMock.mockResolvedValueOnce({
        path: "/tmp/saved.pdf",
        contentType: "application/pdf",
      });

      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: "application/pdf", contentUrl: "https://x/doc.pdf" }], {
          fetchFn: fetchMock as unknown as typeof fetch,
        }),
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.pdf");
      expect(media[0]?.placeholder).toBe("<media:document>");
    });

    it("downloads inline image URLs from html attachments", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = createOkFetchMock("image/png");
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams(
          [
            {
              contentType: "text/html",
              content: '<img src="https://x/inline.png" />',
            },
          ],
          { fetchFn: fetchMock as unknown as typeof fetch },
        ),
      );

      expect(media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("stores inline data:image base64 payloads", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const base64 = Buffer.from("png").toString("base64");
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([
          {
            contentType: "text/html",
            content: `<img src="data:image/png;base64,${base64}" />`,
          },
        ]),
      );

      expect(media).toHaveLength(1);
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("retries with auth when the first request is unauthorized", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
        const headers = new Headers(opts?.headers);
        const hasAuth = Boolean(headers.get("Authorization"));
        if (!hasAuth) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: "image/png", contentUrl: "https://x/img" }], {
          tokenProvider: { getAccessToken: vi.fn(async () => "token") },
          authAllowHosts: ["x"],
          fetchFn: fetchMock as unknown as typeof fetch,
        }),
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(media).toHaveLength(1);
    });

    it("skips auth retries when the host is not in auth allowlist", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const tokenProvider = { getAccessToken: vi.fn(async () => "token") };
      const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
        const headers = new Headers(opts?.headers);
        const hasAuth = Boolean(headers.get("Authorization"));
        if (!hasAuth) {
          return new Response("forbidden", { status: 403 });
        }
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsAttachments(
        buildDownloadParams(
          [{ contentType: "image/png", contentUrl: "https://attacker.azureedge.net/img" }],
          {
            tokenProvider,
            allowHosts: ["azureedge.net"],
            authAllowHosts: ["graph.microsoft.com"],
            fetchFn: fetchMock as unknown as typeof fetch,
          },
        ),
      );

      expect(media).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalled();
      expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    });

    it("skips urls outside the allowlist", async () => {
      const { downloadMSTeamsAttachments } = await load();
      const fetchMock = vi.fn();
      const media = await downloadMSTeamsAttachments(
        buildDownloadParams([{ contentType: "image/png", contentUrl: "https://evil.test/img" }], {
          allowHosts: ["graph.microsoft.com"],
          resolveFn: undefined,
          fetchFn: fetchMock as unknown as typeof fetch,
        }),
      );

      expect(media).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("buildMSTeamsGraphMessageUrls", () => {
    it("builds channel message urls", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "channel",
        conversationId: "19:thread@thread.tacv2",
        messageId: "123",
        channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
      });
      expect(urls[0]).toContain("/teams/team-id/channels/chan-id/messages/123");
    });

    it("builds channel reply urls when replyToId is present", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "channel",
        messageId: "reply-id",
        replyToId: "root-id",
        channelData: { team: { id: "team-id" }, channel: { id: "chan-id" } },
      });
      expect(urls[0]).toContain(
        "/teams/team-id/channels/chan-id/messages/root-id/replies/reply-id",
      );
    });

    it("builds chat message urls", async () => {
      const { buildMSTeamsGraphMessageUrls } = await load();
      const urls = buildMSTeamsGraphMessageUrls({
        conversationType: "groupChat",
        conversationId: "19:chat@thread.v2",
        messageId: "456",
      });
      expect(urls[0]).toContain("/chats/19%3Achat%40thread.v2/messages/456");
    });
  });

  describe("downloadMSTeamsGraphMedia", () => {
    it("downloads hostedContents images", async () => {
      const { downloadMSTeamsGraphMedia } = await load();
      const base64 = Buffer.from("png").toString("base64");
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/hostedContents")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "1",
                  contentType: "image/png",
                  contentBytes: base64,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/attachments")) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const media = await downloadMSTeamsGraphMedia(
        buildDownloadGraphParams(fetchMock as unknown as typeof fetch),
      );

      expect(media.media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalled();
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("merges SharePoint reference attachments with hosted content", async () => {
      const { downloadMSTeamsGraphMedia } = await load();
      const hostedBase64 = Buffer.from("png").toString("base64");
      const shareUrl = "https://contoso.sharepoint.com/site/file";
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/hostedContents")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "hosted-1",
                  contentType: "image/png",
                  contentBytes: hostedBase64,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/attachments")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "ref-1",
                  contentType: "reference",
                  contentUrl: shareUrl,
                  name: "report.pdf",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/shares/")) {
          return new Response(Buffer.from("pdf"), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          });
        }
        if (url.endsWith("/messages/123")) {
          return new Response(
            JSON.stringify({
              attachments: [
                {
                  id: "ref-1",
                  contentType: "reference",
                  contentUrl: shareUrl,
                  name: "report.pdf",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });

      const media = await downloadMSTeamsGraphMedia(
        buildDownloadGraphParams(fetchMock as unknown as typeof fetch),
      );

      expect(media.media).toHaveLength(2);
    });

    it("blocks SharePoint redirects to hosts outside allowHosts", async () => {
      const { downloadMSTeamsGraphMedia } = await load();
      const shareUrl = "https://contoso.sharepoint.com/site/file";
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

      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/hostedContents")) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        if (url.endsWith("/attachments")) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        if (url.endsWith("/messages/123")) {
          return new Response(
            JSON.stringify({
              attachments: [
                {
                  id: "ref-1",
                  contentType: "reference",
                  contentUrl: shareUrl,
                  name: "report.pdf",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/shares/")) {
          return new Response(null, {
            status: 302,
            headers: { location: escapedUrl },
          });
        }
        if (url === escapedUrl) {
          return new Response(Buffer.from("should-not-be-fetched"), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          });
        }
        return new Response("not found", { status: 404 });
      });

      const media = await downloadMSTeamsGraphMedia(
        buildDownloadGraphParams(fetchMock as unknown as typeof fetch, {
          allowHosts: ["graph.microsoft.com", "contoso.sharepoint.com"],
        }),
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
      const { buildMSTeamsMediaPayload } = await load();
      const payload = buildMSTeamsMediaPayload([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.png", contentType: "image/png" },
      ]);
      expect(payload.MediaPath).toBe("/tmp/a.png");
      expect(payload.MediaUrl).toBe("/tmp/a.png");
      expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    });
  });
});
