import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
}));

const runtimeEnvMocks = vi.hoisted(() => ({
  logVerbose: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: runtimeEnvMocks.logVerbose,
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

import {
  detectLineMediaKind,
  LINE_OUTBOUND_MEDIA_MAX_BYTES,
  precheckLineOutboundMediaSize,
  resolveLineOutboundMedia,
  validateLineMediaUrl,
} from "./outbound-media.js";

function buildGuardedHeadResult(params: { status: number; contentLength?: string | null }): {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
} {
  const headers = new Headers();
  if (params.contentLength !== undefined && params.contentLength !== null) {
    headers.set("content-length", params.contentLength);
  }
  const response = new Response(null, { status: params.status, headers });
  return {
    response,
    finalUrl: "https://example.com/asset",
    release: vi.fn(async () => undefined),
  };
}

describe("validateLineMediaUrl", () => {
  beforeEach(() => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
  });

  it("accepts HTTPS URL", async () => {
    await expect(validateLineMediaUrl("https://example.com/image.jpg")).resolves.toBeUndefined();
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("accepts uppercase HTTPS scheme", async () => {
    await expect(validateLineMediaUrl("HTTPS://EXAMPLE.COM/img.jpg")).resolves.toBeUndefined();
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("rejects HTTP URL", async () => {
    await expect(validateLineMediaUrl("http://example.com/image.jpg")).rejects.toThrow(
      /must use HTTPS/i,
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects URL longer than 2000 chars", async () => {
    const longUrl = `https://example.com/${"a".repeat(1981)}`;
    expect(longUrl.length).toBeGreaterThan(2000);
    await expect(validateLineMediaUrl(longUrl)).rejects.toThrow(/2000 chars or less/i);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects private-network targets through the shared SSRF policy", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("SSRF blocked private network target"),
    );

    await expect(validateLineMediaUrl("https://127.0.0.1/image.jpg")).rejects.toThrow(
      /private network/i,
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("127.0.0.1", {
      policy: { allowPrivateNetwork: false },
    });
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
  beforeEach(() => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(
      buildGuardedHeadResult({ status: 200, contentLength: "1024" }),
    );
    runtimeEnvMocks.logVerbose.mockReset();
  });

  it("respects explicit media kind without remote MIME probing", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", { mediaKind: "video" }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
  });

  it("preserves explicit video kind when a preview URL is provided", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", {
        mediaKind: "video",
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("infers audio kind from explicit duration metadata when mediaKind is omitted", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio", {
        durationMs: 60000,
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "audio",
      durationMs: 60000,
    });
  });

  it("does not infer video from previewImageUrl alone", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/image.jpg", {
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/image.jpg",
      mediaKind: "image",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("infers media kinds from known HTTPS file extensions", async () => {
    await expect(resolveLineOutboundMedia("https://example.com/audio.mp3")).resolves.toEqual({
      mediaUrl: "https://example.com/audio.mp3",
      mediaKind: "audio",
    });
    await expect(resolveLineOutboundMedia("https://example.com/video.mp4")).resolves.toEqual({
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
    });
    await expect(resolveLineOutboundMedia("https://example.com/image.jpg")).resolves.toEqual({
      mediaUrl: "https://example.com/image.jpg",
      mediaKind: "image",
    });
  });

  it("validates previewImageUrl when provided", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/video.mp4", {
        mediaKind: "video",
        previewImageUrl: "http://example.com/preview.jpg",
      }),
    ).rejects.toThrow(/must use HTTPS/i);
  });

  it("falls back to image when no explicit LINE media options or known extension are present", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio"),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "image",
    });
  });

  it("rejects local paths because LINE outbound media requires public HTTPS URLs", async () => {
    await expect(resolveLineOutboundMedia("./assets/image.jpg")).rejects.toThrow(
      /requires a public https url/i,
    );
  });

  it("rejects non-HTTPS URL explicitly", async () => {
    await expect(resolveLineOutboundMedia("http://example.com/image.jpg")).rejects.toThrow(
      /must use HTTPS/i,
    );
  });

  it("does not double-probe when previewImageUrl equals the media URL", async () => {
    const sharedUrl = "https://example.com/asset.jpg";
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(
      buildGuardedHeadResult({ status: 200, contentLength: "1024" }),
    );
    await expect(
      resolveLineOutboundMedia(sharedUrl, { previewImageUrl: sharedUrl }),
    ).resolves.toEqual({
      mediaUrl: sharedUrl,
      mediaKind: "image",
      previewImageUrl: sharedUrl,
    });
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("rejects when an explicit previewImageUrl exceeds the LINE preview cap (between 1 MiB and 10 MiB)", async () => {
    const between = 5 * 1024 * 1024; // ≈ 5 MiB — under image cap, over preview cap
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    ssrfMocks.fetchWithSsrFGuard
      .mockResolvedValueOnce(
        buildGuardedHeadResult({ status: 200, contentLength: "1024" }), // media: under cap
      )
      .mockResolvedValueOnce(
        buildGuardedHeadResult({ status: 200, contentLength: String(between) }), // preview: over preview cap
      );
    await expect(
      resolveLineOutboundMedia("https://example.com/video.mp4", {
        mediaKind: "video",
        previewImageUrl: "https://example.com/big-preview.png",
      }),
    ).rejects.toThrow(/LINE preview media must be ≤1048576 bytes \(got 5242880 bytes/);
  });

  it("rejects when previewImageUrl equals mediaUrl and the shared file exceeds the preview cap", async () => {
    const sharedUrl = "https://example.com/shared.jpg";
    const between = 5 * 1024 * 1024;
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(between) }),
    );
    await expect(
      resolveLineOutboundMedia(sharedUrl, { previewImageUrl: sharedUrl }),
    ).rejects.toThrow(/LINE preview media must be ≤1048576 bytes \(got 5242880 bytes/);
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  // T11
  it("rejects a video URL whose HEAD reports a payload larger than the LINE video cap", async () => {
    const oversized = LINE_OUTBOUND_MEDIA_MAX_BYTES.video + 1;
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(oversized) }),
    );
    await expect(
      resolveLineOutboundMedia("https://example.com/big.mp4", {
        mediaKind: "video",
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).rejects.toThrow(/LINE video media must be ≤209715200 bytes/);
  });
});

describe("precheckLineOutboundMediaSize", () => {
  beforeEach(() => {
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    runtimeEnvMocks.logVerbose.mockReset();
  });

  // T1
  it("resolves when HEAD 200 reports a payload under the image cap", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(1024 * 1024) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).not.toHaveBeenCalled();
  });

  // T2
  it("rejects when HEAD 200 reports a payload over the image cap", async () => {
    const oversized = 11 * 1024 * 1024;
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(oversized) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).rejects.toThrow(/LINE image media must be ≤10485760 bytes \(got 11534336 bytes/);
  });

  // T3
  it("soft-fails when content-length is absent", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: null }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(runtimeEnvMocks.logVerbose.mock.calls[0]?.[0]).toMatch(/no content-length/);
  });

  // T4
  it("soft-fails when HEAD returns a non-2xx status", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 405, contentLength: null }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(runtimeEnvMocks.logVerbose.mock.calls[0]?.[0]).toMatch(/status 405/);
  });

  // T5
  it("soft-fails when the probe throws", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(runtimeEnvMocks.logVerbose.mock.calls[0]?.[0]).toMatch(/probe failed/);
  });

  // T6
  it("soft-fails when content-length is malformed", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: "abc" }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(runtimeEnvMocks.logVerbose.mock.calls[0]?.[0]).toMatch(/malformed content-length/);
  });

  // T7
  it("soft-fails when content-length is negative", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: "-5" }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(runtimeEnvMocks.logVerbose.mock.calls[0]?.[0]).toMatch(/malformed content-length/);
  });

  // T8
  it("resolves when content-length is exactly at the image cap (inclusive)", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({
        status: 200,
        contentLength: String(LINE_OUTBOUND_MEDIA_MAX_BYTES.image),
      }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg", "image"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).not.toHaveBeenCalled();
  });

  // T9
  it("rejects with the video cap when a 250 MiB video is probed", async () => {
    const oversized = 250 * 1024 * 1024;
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(oversized) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/video.mp4", "video"),
    ).rejects.toThrow(/LINE video media must be ≤209715200 bytes \(got 262144000 bytes/);
  });

  // T10
  it("resolves for an under-cap audio probe", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(5 * 1024 * 1024) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/audio.m4a", "audio"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).not.toHaveBeenCalled();
  });

  it("rejects with the preview cap when kind=preview and content-length is between 1 MiB and 10 MiB", async () => {
    const between = 5 * 1024 * 1024; // under image cap, over preview cap
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(between) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/preview.png", "preview"),
    ).rejects.toThrow(/LINE preview media must be ≤1048576 bytes \(got 5242880 bytes/);
  });

  it("resolves when kind=preview and content-length is exactly at the 1 MiB preview cap (inclusive)", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({
        status: 200,
        contentLength: String(LINE_OUTBOUND_MEDIA_MAX_BYTES.preview),
      }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/preview.png", "preview"),
    ).resolves.toBeUndefined();
    expect(runtimeEnvMocks.logVerbose).not.toHaveBeenCalled();
  });

  it("issues a HEAD request through fetchWithSsrFGuard with the strict LINE outbound policy", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: "1024" }),
    );
    await precheckLineOutboundMediaSize("https://example.com/image.jpg", "image");
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/image.jpg",
        init: { method: "HEAD" },
        requireHttps: true,
        mode: "strict",
        timeoutMs: 5000,
        policy: { allowPrivateNetwork: false },
      }),
    );
  });

  it("redacts the probed URL (no query string) in the rejection message", async () => {
    const oversized = 11 * 1024 * 1024;
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(
      buildGuardedHeadResult({ status: 200, contentLength: String(oversized) }),
    );
    await expect(
      precheckLineOutboundMediaSize("https://example.com/image.jpg?sig=secret-token", "image"),
    ).rejects.toThrow(/from https:\/\/example\.com\/image\.jpg\)/);
  });

  it("releases the dispatcher after a successful probe", async () => {
    const release = vi.fn(async () => undefined);
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(null, {
        status: 200,
        headers: new Headers({ "content-length": "1024" }),
      }),
      finalUrl: "https://example.com/image.jpg",
      release,
    });
    await precheckLineOutboundMediaSize("https://example.com/image.jpg", "image");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
