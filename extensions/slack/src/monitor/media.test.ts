import * as ssrf from "openclaw/plugin-sdk/infra-runtime";
import * as mediaFetch from "openclaw/plugin-sdk/media-runtime";
import type { SavedMedia } from "openclaw/plugin-sdk/media-runtime";
import * as mediaStore from "openclaw/plugin-sdk/media-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FetchMock,
  withFetchPreconnect,
} from "../../../../test/helpers/plugins/fetch-mock.js";
import {
  fetchWithSlackAuth,
  resolveSlackAttachmentContent,
  resolveSlackMedia,
  resolveSlackThreadHistory,
} from "./media.js";

// Store original fetch
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn<FetchMock>>;
const originalResolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
type LookupFn = NonNullable<
  Parameters<typeof ssrf.resolvePinnedHostnameWithPolicy>[1]["lookupFn"]
>;
const createSavedMedia = (filePath: string, contentType: string): SavedMedia => ({
  id: "saved-media-id",
  path: filePath,
  size: 128,
  contentType,
});

describe("fetchWithSlackAuth", () => {
  beforeEach(() => {
    // Create a new mock for each test
    mockFetch = vi.fn<FetchMock>(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(),
    );
    globalThis.fetch = withFetchPreconnect(mockFetch);
    const lookupMock = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as
      LookupFn;
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params) =>
      originalResolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
    );
  });

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends Authorization header on initial request with manual redirect", async () => {
    // Simulate direct 200 response (no redirect)
    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("image/jpeg");
    await expect(result.arrayBuffer()).resolves.toSatisfy(
      (body) => Buffer.from(body).toString("utf8") === "image data",
    );

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://files.slack.com/test.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });

  it("rejects non-Slack hosts to avoid leaking tokens", async () => {
    await expect(
      fetchWithSlackAuth("https://example.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/non-Slack host|non-Slack/i);

    // Should fail fast without attempting a fetch.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps Authorization on redirects that stay on Slack hosts", async () => {
    // First call: redirect response from Slack
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "https://cdn.slack-edge.com/presigned-url?sig=abc123" },
    });

    // Second call: actual file content from CDN
    const fileResponse = new Response(Buffer.from("actual image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call should have Authorization header and manual redirect
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://files.slack.com/test.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );

    // Second call should keep Authorization for Slack-owned redirect targets.
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://cdn.slack-edge.com/presigned-url?sig=abc123",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });

  it("handles relative redirect URLs", async () => {
    // Redirect with relative URL
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "/files/redirect-target" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/original.jpg", "xoxb-test-token");

    // Second call should resolve the relative URL against the original
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://files.slack.com/files/redirect-target",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });

  it("drops Authorization when redirects leave Slack-owned hosts", async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "https://example.com/presigned-url?sig=abc123" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/presigned-url?sig=abc123",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("rejects redirects that downgrade to HTTP", async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "http://example.com/presigned-url?sig=abc123" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse);

    await expect(
      fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/non-HTTPS protocol/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns redirect response when no location header is provided", async () => {
    // Redirect without location header
    const redirectResponse = new Response(null, {
      status: 302,
      // No location header
    });

    mockFetch.mockResolvedValueOnce(redirectResponse);

    await expect(
      fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/missing location header/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 4xx/5xx responses directly without following", async () => {
    const errorResponse = new Response("Not Found", {
      status: 404,
    });

    mockFetch.mockResolvedValueOnce(errorResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result.status).toBe(404);
    await expect(result.text()).resolves.toBe("Not Found");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 301 permanent redirects", async () => {
    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: "https://cdn.slack.com/new-url" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://cdn.slack.com/new-url",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });

  it("blocks redirect targets that fail Slack media SSRF policy", async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "https://cdn.slack-edge.com/presigned-url?sig=abc123" },
    });

    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(
      async (hostname, params) => {
        const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
        if (normalized === "cdn.slack-edge.com") {
          throw new Error("Blocked: resolves to private/internal/special-use IP address");
        }
        const lookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as
          LookupFn;
        return await originalResolvePinnedHostnameWithPolicy(hostname, {
          ...params,
          lookupFn,
        });
      },
    );

    mockFetch.mockResolvedValueOnce(redirectResponse);

    await expect(
      fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/private\/internal\/special-use/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("resolveSlackMedia", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = withFetchPreconnect(mockFetch);
    mockPinnedHostnameResolution();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prefers url_private_download over url_private", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );

    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/private.jpg",
          url_private_download: "https://files.slack.com/download.jpg",
          name: "test.jpg",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://files.slack.com/download.jpg",
      expect.anything(),
    );
  });

  it("returns null when download fails", async () => {
    // Simulate a network error
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("keeps Authorization on Slack-host redirects during media downloads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://files.slack.com/test.jpg") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.slack-edge.com/presigned-url?sig=abc123" },
        });
      }
      if (url === "https://cdn.slack-edge.com/presigned-url?sig=abc123") {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer xoxb-test-token") {
          return new Response("<!DOCTYPE html><html><body>login</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(Buffer.from("image data"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result?.[0]?.path).toBe("/tmp/test.jpg");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });

  it("returns null when no files are provided", async () => {
    const result = await resolveSlackMedia({
      files: [],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("skips files without url_private", async () => {
    const result = await resolveSlackMedia({
      files: [{ name: "test.jpg" }], // No url_private
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects HTML auth pages for non-HTML files", async () => {
    const saveMediaBufferMock = vi.spyOn(mediaStore, "saveMediaBuffer");
    mockFetch.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><body>login</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("allows expected HTML uploads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/page.html", "text/html"),
    );
    mockFetch.mockResolvedValueOnce(
      new Response("<!doctype html><html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/page.html",
          name: "page.html",
          mimetype: "text/html",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result?.[0]?.path).toBe("/tmp/page.html");
  });

  it("overrides video/* MIME to audio/* for slack_audio voice messages", async () => {
    // saveMediaBuffer re-detects MIME from buffer bytes, so it may return
    // video/mp4 for MP4 containers.  Verify resolveSlackMedia preserves
    // the overridden audio/* type in its return value despite this.
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/voice.mp4", "video/mp4"));

    const mockResponse = new Response(Buffer.from("audio data"), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/voice.mp4",
          name: "audio_message.mp4",
          mimetype: "video/mp4",
          subtype: "slack_audio",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 16 * 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    // saveMediaBuffer should receive the overridden audio/mp4
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      "audio/mp4",
      "inbound",
      16 * 1024 * 1024,
    );
    // Returned contentType must be the overridden value, not the
    // re-detected video/mp4 from saveMediaBuffer
    expect(result![0]?.contentType).toBe("audio/mp4");
  });

  it("preserves original MIME for non-voice Slack files", async () => {
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/video.mp4", "video/mp4"));

    const mockResponse = new Response(Buffer.from("video data"), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/clip.mp4",
          name: "recording.mp4",
          mimetype: "video/mp4",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 16 * 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      16 * 1024 * 1024,
    );
    expect(result![0]?.contentType).toBe("video/mp4");
  });

  it("falls through to next file when first file returns error", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );

    // First file: 404
    const errorResponse = new Response("Not Found", { status: 404 });
    // Second file: success
    const successResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(successResponse);

    const result = await resolveSlackMedia({
      files: [
        { url_private: "https://files.slack.com/first.jpg", name: "first.jpg" },
        { url_private: "https://files.slack.com/second.jpg", name: "second.jpg" },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns all successfully downloaded files as an array", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (buffer, _contentType) => {
      const text = Buffer.from(buffer).toString("utf8");
      if (text.includes("image a")) {
        return createSavedMedia("/tmp/a.jpg", "image/jpeg");
      }
      if (text.includes("image b")) {
        return createSavedMedia("/tmp/b.png", "image/png");
      }
      return createSavedMedia("/tmp/unknown", "application/octet-stream");
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/a.jpg")) {
        return new Response(Buffer.from("image a"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("/b.png")) {
        return new Response(Buffer.from("image b"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await resolveSlackMedia({
      files: [
        { url_private: "https://files.slack.com/a.jpg", name: "a.jpg" },
        { url_private: "https://files.slack.com/b.png", name: "b.png" },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toHaveLength(2);
    expect(result![0].path).toBe("/tmp/a.jpg");
    expect(result![0].placeholder).toBe("[Slack file: a.jpg]");
    expect(result![1].path).toBe("/tmp/b.png");
    expect(result![1].placeholder).toBe("[Slack file: b.png]");
  });

  it("caps downloads to 8 files for large multi-attachment messages", async () => {
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/x.jpg", "image/jpeg"));

    mockFetch.mockImplementation(async () => {
      return new Response(Buffer.from("image data"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });

    const files = Array.from({ length: 9 }, (_, idx) => ({
      url_private: `https://files.slack.com/file-${idx}.jpg`,
      name: `file-${idx}.jpg`,
      mimetype: "image/jpeg",
    }));

    const result = await resolveSlackMedia({
      files,
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(8);
    expect(saveMediaBufferMock).toHaveBeenCalledTimes(8);
    expect(mockFetch).toHaveBeenCalledTimes(8);
  });
});

describe("Slack media SSRF policy", () => {
  const originalFetchLocal = globalThis.fetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = withFetchPreconnect(mockFetch);
    mockPinnedHostnameResolution();
  });

  afterEach(() => {
    globalThis.fetch = originalFetchLocal;
    vi.restoreAllMocks();
  });

  it("passes ssrfPolicy with Slack CDN allowedHostnames and allowRfc2544BenchmarkRange to file downloads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const spy = vi.spyOn(mediaFetch, "fetchRemoteMedia");

    await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
      }),
    );

    const policy = spy.mock.calls[0][0].ssrfPolicy;
    expect(policy?.allowedHostnames).toEqual(
      expect.arrayContaining(["*.slack.com", "*.slack-edge.com", "*.slack-files.com"]),
    );
  });

  it("passes ssrfPolicy to forwarded attachment image downloads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/fwd.jpg", "image/jpeg"),
    );
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      return {
        hostname: normalized,
        addresses: ["93.184.216.34"],
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: ["93.184.216.34"] }),
      };
    });
    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("fwd"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const spy = vi.spyOn(mediaFetch, "fetchRemoteMedia");

    await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
      }),
    );
  });
});

describe("resolveSlackAttachmentContent", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = withFetchPreconnect(mockFetch);
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("ignores non-forwarded attachments", async () => {
    const result = await resolveSlackAttachmentContent({
      attachments: [
        {
          text: "unfurl text",
          is_msg_unfurl: true,
          image_url: "https://example.com/unfurl.jpg",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("extracts text from forwarded shared attachments", async () => {
    const result = await resolveSlackAttachmentContent({
      attachments: [
        {
          is_share: true,
          author_name: "Bob",
          text: "Please review this",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({
      text: "[Forwarded message from Bob]\nPlease review this",
      media: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips forwarded image URLs on non-Slack hosts", async () => {
    const saveMediaBufferMock = vi.spyOn(mediaStore, "saveMediaBuffer");

    const result = await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://example.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("downloads Slack-hosted images from forwarded shared attachments", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/forwarded.jpg", "image/jpeg"),
    );

    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("forwarded image"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );

    const result = await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({
      text: "",
      media: [
        {
          path: "/tmp/forwarded.jpg",
          contentType: "image/jpeg",
          placeholder: "[Forwarded image: forwarded.jpg]",
        },
      ],
    });
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://files.slack.com/forwarded.jpg");
    const firstInit = firstCall?.[1];
    expect(firstInit?.redirect).toBe("manual");
    expect(new Headers(firstInit?.headers).get("Authorization")).toBe("Bearer xoxb-test-token");
  });
});

describe("resolveSlackThreadHistory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paginates and returns the latest N messages across pages", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 1}`,
          user: "U1",
          ts: `${i + 1}.000`,
        })),
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 60 }, (_, i) => ({
          text: `msg-${i + 201}`,
          user: "U1",
          ts: `${i + 201}.000`,
        })),
        response_metadata: { next_cursor: "" },
      });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      currentMessageTs: "260.000",
      limit: 5,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
      }),
    );
    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
        cursor: "cursor-2",
      }),
    );
    expect(result.map((entry) => entry.ts)).toEqual([
      "255.000",
      "256.000",
      "257.000",
      "258.000",
      "259.000",
    ]);
  });

  it("includes file-only messages and drops empty-only entries", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        { text: "  ", ts: "1.000", files: [{ name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("[attached: screenshot.png]");
    expect(result[1]?.text).toBe("hello");
  });

  it("returns empty when limit is zero without calling Slack API", async () => {
    const replies = vi.fn();
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 0,
    });

    expect(result).toEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });

  it("returns empty when Slack API throws", async () => {
    const replies = vi.fn().mockRejectedValueOnce(new Error("slack down"));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 20,
    });

    expect(result).toEqual([]);
  });
});
