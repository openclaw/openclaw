import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTlonInboundMediaPrompt, downloadMessageImages } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  saveRemoteMedia: vi.fn(),
}));

const saveRemoteMediaMock = vi.mocked(saveRemoteMedia);

describe("tlon monitor media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps downloaded images at eight per message", async () => {
    const content = Array.from({ length: 10 }, (_, index) => ({
      block: { image: { src: `https://example.com/${index}.png`, alt: `image-${index}` } },
    }));
    saveRemoteMediaMock.mockImplementation(async ({ url }) => ({
      id: `photo-${url}.png`,
      path: `/tmp/openclaw/media/inbound/${url.split("/").pop()}`,
      size: 10,
      contentType: "image/png",
    }));

    const result = await downloadMessageImages(content);

    expect(result).toMatchObject({ unavailableCount: 2 });
    expect(result.attachments).toHaveLength(8);
    expect(saveRemoteMediaMock.mock.calls.map(([options]) => options.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("keeps the duplicated path projection byte-stable beside ordered facts", () => {
    expect(
      buildTlonInboundMediaPrompt("caption", [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ]),
    ).toEqual({
      body: [
        "[media attached: /tmp/a.png (image/png) | /tmp/a.png]",
        "[media attached: /tmp/b.jpg (image/jpeg) | /tmp/b.jpg]",
        "caption",
      ].join("\n"),
      media: [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ],
    });
  });

  it.each([
    { maxBytes: undefined, expectedMaxBytes: MAX_IMAGE_BYTES },
    { maxBytes: 1024, expectedMaxBytes: 1024 },
    { maxBytes: MAX_IMAGE_BYTES * 2, expectedMaxBytes: MAX_IMAGE_BYTES },
  ])(
    "stores fetched media with the effective $expectedMaxBytes byte cap",
    async ({ maxBytes, expectedMaxBytes }) => {
      saveRemoteMediaMock.mockResolvedValue({
        id: "photo---uuid.png",
        path: "/tmp/openclaw/media/inbound/photo---uuid.png",
        size: "image-data".length,
        contentType: "image/png",
      });

      const result = await downloadMessageImages(
        [{ block: { image: { src: "https://example.com/photo.png" } } }],
        maxBytes,
      );

      expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
      expect(saveRemoteMediaMock).toHaveBeenCalledWith({
        url: "https://example.com/photo.png",
        maxBytes: expectedMaxBytes,
        responseHeaderTimeoutMs: 120_000,
        readIdleTimeoutMs: 30_000,
        ssrfPolicy: undefined,
        requestInit: { method: "GET" },
      });
      expect(result).toEqual({
        attachments: [
          { path: "/tmp/openclaw/media/inbound/photo---uuid.png", contentType: "image/png" },
        ],
        unavailableCount: 0,
      });
    },
  );

  it("reports an unavailable image when the fetch exceeds the image cap", async () => {
    saveRemoteMediaMock.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/photo.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await downloadMessageImages([
      { block: { image: { src: "https://example.com/photo.png" } } },
    ]);

    expect(result).toEqual({ attachments: [], unavailableCount: 1 });
  });
});
