import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

import { buildLineMediaMessage } from "./outbound-media.js";

const PREVIEW_URL = "https://example.com/preview.jpg";
const AUDIO_URL = "https://example.com/download?id=audio";
const VIDEO_URL = "https://example.com/clip.mp4";
const INSECURE_PREVIEW_URL =
  "http://line-user:line-fixture@example.com/image.jpg?auth=line-query#line-fragment";

function build(
  url: string,
  options: Parameters<typeof buildLineMediaMessage>[1] = {},
  target = "line:user:Uabc",
) {
  return buildLineMediaMessage(url, options, target);
}

beforeEach(() => {
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset().mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
});

describe("buildLineMediaMessage", () => {
  it.each([
    {
      name: "malformed media URL",
      run: () => build("not a url?query=fixture#fragment"),
      expected: new Error("LINE outbound media currently requires a public HTTPS URL"),
    },
    {
      name: "insecure preview URL",
      run: () => build(VIDEO_URL, { mediaKind: "video", previewImageUrl: INSECURE_PREVIEW_URL }),
      expected: new Error("LINE outbound media URL must use HTTPS"),
    },
  ])("does not expose credentials from a $name", async ({ run, expected }) => {
    await expect(run()).rejects.toThrow(expected);
  });

  it("rejects a URL longer than 2000 chars before any hostname lookup", async () => {
    const longUrl = `https://example.com/${"a".repeat(1981)}`;
    expect(longUrl.length).toBeGreaterThan(2000);
    await expect(build(longUrl)).rejects.toThrow(/2000 chars or less/i);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects private-network targets through the shared SSRF policy", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("SSRF blocked private network target"),
    );

    await expect(build("https://127.0.0.1/image.jpg")).rejects.toThrow(/private network/i);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("127.0.0.1", {
      policy: { allowPrivateNetwork: false },
    });
  });
  it("infers audio from explicit duration metadata when mediaKind is omitted", async () => {
    await expect(build(AUDIO_URL, { durationMs: 30000 })).resolves.toEqual({
      type: "audio",
      originalContentUrl: AUDIO_URL,
      duration: 30000,
    });
  });

  it("defaults an untyped URL to an image message", async () => {
    await expect(build(AUDIO_URL)).resolves.toMatchObject({
      type: "image",
      originalContentUrl: AUDIO_URL,
    });
  });

  it.each(["https://example.com/image.webp", "https://example.com/file.unknown", VIDEO_URL])(
    "delivers unsupported or posterless %s as its URL",
    async (url) => {
      await expect(build(url)).resolves.toEqual({
        type: "text",
        text: url,
      });
    },
  );

  it("names the missing preview image when tracking metadata declares video intent", async () => {
    await expect(
      build("https://example.com/download?id=video", { trackingId: "track-1" }),
    ).rejects.toThrow(/require previewImageUrl/i);
  });

  it("gates trackingId on user targets", async () => {
    const options = {
      mediaKind: "video" as const,
      previewImageUrl: PREVIEW_URL,
      trackingId: "track-1",
    };
    const expected = {
      type: "video",
      originalContentUrl: VIDEO_URL,
      previewImageUrl: PREVIEW_URL,
    };
    await expect(build(VIDEO_URL, options)).resolves.toEqual({
      ...expected,
      trackingId: "track-1",
    });
    await expect(build(VIDEO_URL, options, "line:group:Cabc")).resolves.toEqual(expected);
  });
});
