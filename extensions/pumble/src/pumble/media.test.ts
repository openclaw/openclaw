import { describe, expect, it } from "vitest";
import { mediaKindFromMime, buildPumbleAttachmentPlaceholder, type MediaInfo } from "./media.js";

describe("mediaKindFromMime", () => {
  it("returns 'unknown' for null/undefined", () => {
    expect(mediaKindFromMime(null)).toBe("unknown");
    expect(mediaKindFromMime(undefined)).toBe("unknown");
    expect(mediaKindFromMime("")).toBe("unknown");
  });

  it("detects image types", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("image/jpeg")).toBe("image");
    expect(mediaKindFromMime("image/webp")).toBe("image");
  });

  it("detects audio types", () => {
    expect(mediaKindFromMime("audio/mpeg")).toBe("audio");
    expect(mediaKindFromMime("audio/ogg")).toBe("audio");
  });

  it("detects video types", () => {
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("video/webm")).toBe("video");
  });

  it("falls back to 'document' for other types", () => {
    expect(mediaKindFromMime("application/pdf")).toBe("document");
    expect(mediaKindFromMime("text/plain")).toBe("document");
  });
});

describe("buildPumbleAttachmentPlaceholder", () => {
  it("returns empty string for no media", () => {
    expect(buildPumbleAttachmentPlaceholder([])).toBe("");
  });

  it("returns single media placeholder", () => {
    const media: MediaInfo[] = [{ path: "/tmp/a.png", kind: "image" }];
    expect(buildPumbleAttachmentPlaceholder(media)).toBe("<media:image>");
  });

  it("uses 'document' for unknown kind in single item", () => {
    const media: MediaInfo[] = [{ path: "/tmp/a.bin", kind: "unknown" }];
    expect(buildPumbleAttachmentPlaceholder(media)).toBe("<media:document>");
  });

  it("returns multiple image placeholder with count", () => {
    const media: MediaInfo[] = [
      { path: "/tmp/a.png", kind: "image" },
      { path: "/tmp/b.jpg", kind: "image" },
    ];
    expect(buildPumbleAttachmentPlaceholder(media)).toBe("<media:image> (2 images)");
  });

  it("returns mixed media placeholder with count", () => {
    const media: MediaInfo[] = [
      { path: "/tmp/a.png", kind: "image" },
      { path: "/tmp/b.pdf", kind: "document" },
    ];
    expect(buildPumbleAttachmentPlaceholder(media)).toBe("<media:document> (2 files)");
  });

  it("returns 3+ items correctly", () => {
    const media: MediaInfo[] = [
      { path: "/tmp/a.png", kind: "image" },
      { path: "/tmp/b.png", kind: "image" },
      { path: "/tmp/c.png", kind: "image" },
    ];
    expect(buildPumbleAttachmentPlaceholder(media)).toBe("<media:image> (3 images)");
  });
});
