import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(),
  };
});

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
  vi.clearAllMocks();
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
  async function getGuardedFetchMock() {
    const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/infra-runtime");
    return vi.mocked(fetchWithSsrFGuard);
  }

  it("respects explicit media kind without remote MIME probing", async () => {
    const guardedFetch = await getGuardedFetchMock();

    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", { mediaKind: "video" }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("detects video kind from extensionless URL via HEAD content-type", async () => {
    const guardedFetch = await getGuardedFetchMock();
    const release = vi.fn().mockResolvedValue(undefined);
    guardedFetch.mockResolvedValue({
      response: responseWithContentType("video/mp4"),
      finalUrl: "https://example.com/download?id=123",
      release,
    });

    await expect(resolveLineOutboundMedia("https://example.com/download?id=123")).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "strict",
        url: "https://example.com/download?id=123",
        timeoutMs: LINE_MEDIA_KIND_PROBE_TIMEOUT_MS,
        init: expect.objectContaining({ method: "HEAD" }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to GET when HEAD cannot determine MIME", async () => {
    const guardedFetch = await getGuardedFetchMock();
    const releaseHead = vi.fn().mockResolvedValue(undefined);
    const releaseGet = vi.fn().mockResolvedValue(undefined);
    guardedFetch
      .mockResolvedValueOnce({
        response: responseWithContentType("application/octet-stream"),
        finalUrl: "https://example.com/download?id=audio",
        release: releaseHead,
      })
      .mockResolvedValueOnce({
        response: responseWithContentType("audio/mpeg"),
        finalUrl: "https://example.com/download?id=audio",
        release: releaseGet,
      });

    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio"),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "audio",
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        init: expect.objectContaining({ method: "HEAD" }),
      }),
    );
    expect(guardedFetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        init: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Range: "bytes=0-0" }),
        }),
      }),
    );
    expect(releaseHead).toHaveBeenCalledTimes(1);
    expect(releaseGet).toHaveBeenCalledTimes(1);
  });

  it("falls back to image when MIME probing times out", async () => {
    const guardedFetch = await getGuardedFetchMock();
    guardedFetch.mockRejectedValue(new Error("timeout"));

    await expect(resolveLineOutboundMedia("https://example.com/download?id=slow")).resolves.toEqual(
      {
        mediaUrl: "https://example.com/download?id=slow",
        mediaKind: "image",
      },
    );
    expect(guardedFetch).toHaveBeenCalledTimes(2);
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
