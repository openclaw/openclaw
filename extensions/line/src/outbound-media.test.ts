import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINE_MEDIA_KIND_PROBE_TIMEOUT_MS,
  detectLineMediaKind,
  resolveLineOutboundMedia,
  validateLineMediaUrl,
} from "./outbound-media.js";

function responseWithContentType(contentType: string | null): Response {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
  it("respects explicit media kind without remote MIME probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", { mediaKind: "video" }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects video kind from extensionless URL via HEAD content-type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWithContentType("video/mp4"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLineOutboundMedia("https://example.com/download?id=123")).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/download?id=123",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("falls back to GET when HEAD cannot determine MIME", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve(responseWithContentType("application/octet-stream"));
      }
      return Promise.resolve(responseWithContentType("audio/mpeg"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio"),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "audio",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://example.com/download?id=audio",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/download?id=audio",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to image when MIME probing times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = resolveLineOutboundMedia("https://example.com/download?id=slow");
    await vi.advanceTimersByTimeAsync(LINE_MEDIA_KIND_PROBE_TIMEOUT_MS * 2 + 20);

    await expect(pending).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=slow",
      mediaKind: "image",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
