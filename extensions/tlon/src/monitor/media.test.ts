import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTlonInboundMediaPrompt, downloadMessageImages } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  saveRemoteMedia: vi.fn(),
}));

const saveMedia = vi.mocked(saveRemoteMedia);
const photoUrl = "https://example.com/photo.png";
const imageBlock = (src: string) => ({ block: { image: { src } } });
const attachment = { path: "/tmp/photo.png", contentType: "image/png" };
const savedImage = { ...attachment, id: "photo", size: 10 };

describe("tlon monitor media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("caps downloaded images at eight per message", async () => {
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`);
    saveMedia.mockImplementation(async ({ url }) => ({
      ...savedImage,
      id: `photo-${url}.png`,
      path: `/tmp/openclaw/media/inbound/${url.split("/").pop()}`,
    }));

    const result = await downloadMessageImages(urls.map(imageBlock));

    expect([result.unavailableCount, result.attachments.length]).toEqual([2, 8]);
    expect(saveMedia.mock.calls.map(([options]) => options.url)).toEqual(urls.slice(0, 8));
  });

  it("keeps the duplicated path projection byte-stable beside ordered facts", () => {
    const media = [
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.jpg", contentType: "image/jpeg" },
    ];
    const expected = {
      body: `[media attached: /tmp/a.png (image/png) | /tmp/a.png]
[media attached: /tmp/b.jpg (image/jpeg) | /tmp/b.jpg]
caption`,
      media: structuredClone(media),
    };
    expect(buildTlonInboundMediaPrompt("caption", media)).toEqual(expected);
  });

  it.each([
    [undefined, MAX_IMAGE_BYTES],
    [1024, 1024],
    [MAX_IMAGE_BYTES * 2, MAX_IMAGE_BYTES],
  ])("stores fetched media with cap %s as %s bytes", async (maxBytes, expectedMaxBytes) => {
    saveMedia.mockResolvedValue(savedImage);
    const result = await downloadMessageImages([imageBlock(photoUrl)], maxBytes);

    expect(saveMedia).toHaveBeenCalledExactlyOnceWith({
      url: photoUrl,
      maxBytes: expectedMaxBytes,
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    expect(result).toEqual({
      attachments: [attachment],
      unavailableCount: 0,
    });
  });

  it.each([
    [photoUrl, "error", "Error downloading inbound media"],
    ["data:image/png;base64,private-inbound-image", "warn", "Rejected non-http(s) media URL"],
  ] as const)("reports unavailable media without exposing %s", async (url, level, message) => {
    if (level === "error") {
      saveMedia.mockRejectedValue(new Error(`${url}: exceeds maxBytes ${MAX_IMAGE_BYTES}`));
    }
    expect(await downloadMessageImages([imageBlock(url)])).toEqual({
      attachments: [],
      unavailableCount: 1,
    });
    if (level === "warn") {
      expect(saveMedia).not.toHaveBeenCalled();
    }
    expect(console[level]).toHaveBeenCalledWith(`[tlon-media] ${message}`);
    expect(JSON.stringify(vi.mocked(console[level]).mock.calls)).not.toContain(url);
  });
});
