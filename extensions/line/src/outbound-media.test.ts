import { describe, expect, it } from "vitest";
import {
  detectLineMediaKind,
  resolveLineOutboundMedia,
  validateLineMediaUrl,
} from "./outbound-media.js";

describe("validateLineMediaUrl", () => {
  it("accepts HTTPS URL", () => {
    expect(() => validateLineMediaUrl("https://example.com/image.jpg")).not.toThrow();
  });

  it("accepts uppercase HTTPS scheme", () => {
    expect(() => validateLineMediaUrl("HTTPS://EXAMPLE.COM/img.jpg")).not.toThrow();
  });

  it("rejects HTTP URL", () => {
    expect(() => validateLineMediaUrl("http://example.com/image.jpg")).toThrow(/must use HTTPS/i);
  });

  it("rejects URL longer than 2000 chars", () => {
    const longUrl = `https://example.com/${"a".repeat(1981)}`;
    expect(longUrl.length).toBeGreaterThan(2000);
    expect(() => validateLineMediaUrl(longUrl)).toThrow(/2000 chars or less/i);
  });
});

describe("detectLineMediaKind", () => {
  it("maps image MIME to image", () => {
    expect(detectLineMediaKind("image/jpeg")).toBe("image");
  });

  it("maps uppercase image MIME to image", () => {
    expect(detectLineMediaKind("IMAGE/JPEG")).toBe("image");
  });

  it("maps video MIME to video", () => {
    expect(detectLineMediaKind("video/mp4")).toBe("video");
  });

  it("maps audio MIME to audio", () => {
    expect(detectLineMediaKind("audio/mpeg")).toBe("audio");
  });

  it("falls back unknown MIME to image", () => {
    expect(detectLineMediaKind("application/octet-stream")).toBe("image");
  });
});

describe("resolveLineOutboundMedia", () => {
  it("returns HTTPS URL as-is with inferred media kind", async () => {
    await expect(resolveLineOutboundMedia("https://example.com/image.jpg")).resolves.toEqual({
      mediaUrl: "https://example.com/image.jpg",
      mediaKind: "image",
    });
  });

  it("honors an explicit media kind without inferring from preview image hints", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/media.mp3", {
        mediaKind: "audio",
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/media.mp3",
      mediaKind: "audio",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("throws for local paths because LINE outbound media requires public HTTPS URLs", async () => {
    await expect(resolveLineOutboundMedia("./assets/image.jpg")).rejects.toThrow(
      /publicly accessible HTTPS URL/i,
    );
  });

  it("rejects non-HTTPS URL explicitly", async () => {
    await expect(resolveLineOutboundMedia("http://example.com/image.jpg")).rejects.toThrow(
      /must use HTTPS/i,
    );
  });
});
