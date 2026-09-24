import {
  type APIAttachment,
  type APIStickerItem,
  MessageReferenceType,
  StickerFormatType,
} from "discord-api-types/v10";
// Discord tests cover message utils plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../internal/discord.js";

const saveRemoteMedia = vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").saveRemoteMedia>();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, saveRemoteMedia };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: () => {},
  };
});

let resolveForwardedMediaList: typeof import("./message-media.js").resolveForwardedMediaList;
let resolveMediaList: typeof import("./message-media.js").resolveMediaList;
const DISCORD_API_URL_ENV = "DISCORD_API_URL";

beforeAll(async () => {
  ({ resolveForwardedMediaList, resolveMediaList } = await import("./message-media.js"));
});

afterEach(() => {
  delete process.env[DISCORD_API_URL_ENV];
  vi.restoreAllMocks();
});
beforeEach(() => vi.resetAllMocks());

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

type AttachmentFixture = Pick<APIAttachment, "id" | "filename" | "url"> &
  Partial<Omit<APIAttachment, "id" | "filename" | "url">>;

function attachmentFixture(
  id: string,
  filename: string,
  overrides: Partial<APIAttachment> = {},
): AttachmentFixture {
  return {
    id,
    filename,
    url: `https://cdn.discordapp.com/attachments/1/${filename}`,
    content_type: "image/png",
    ...overrides,
  };
}

function stickerFixture(id: string, name: string): APIStickerItem {
  return { id, name, format_type: StickerFormatType.PNG };
}

function mockDownload(path: string, options: { contentType?: string } = {}): void {
  saveRemoteMedia.mockResolvedValueOnce({
    id: "saved-media",
    path,
    size: 5,
    contentType: options.contentType ?? "image/png",
  });
}

function installMediaEndpoint(): void {
  process.env[DISCORD_API_URL_ENV] = "http://127.0.0.1:43210/api/v10";
}

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

function fetchParams(): Parameters<typeof saveRemoteMedia>[0] {
  const call = saveRemoteMedia.mock.calls[0];
  if (!call) {
    throw new Error("Expected saved media request");
  }
  return call[0];
}

function expectDiscordCdnSsrFPolicy(policy: Parameters<typeof saveRemoteMedia>[0]["ssrfPolicy"]) {
  expect(policy?.allowRfc2544BenchmarkRange).toBe(true);
  expect(policy?.hostnameAllowlist).toEqual(expect.arrayContaining(DISCORD_CDN_HOSTNAMES));
}

function expectSinglePngDownload(params: {
  result: unknown;
  expectedUrl: string;
  filePathHint: string;
  expectedPath: string;
  kind?: "sticker";
}) {
  expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
  const call = fetchParams();
  expect(call.url).toBe(params.expectedUrl);
  expect(call.filePathHint).toBe(params.filePathHint);
  expect(call.maxBytes).toBe(512);
  expect(call.fetchImpl).toBeUndefined();
  expectDiscordCdnSsrFPolicy(call.ssrfPolicy);
  expect(call.fallbackContentType).toBe("image/png");
  expect(call.originalFilename).toBe(params.filePathHint);
  expect(params.result).toEqual([
    {
      path: params.expectedPath,
      contentType: "image/png",
      fileName: params.filePathHint,
      ...(params.kind ? { kind: params.kind } : {}),
    },
  ]);
}

function expectAttachmentImageFallback(params: { result: unknown }) {
  expect(saveRemoteMedia).toHaveBeenCalledOnce();
  expect(params.result).toEqual([
    {
      contentType: "image/png",
    },
  ]);
}

function asReferencedForwardMessage(attachments: AttachmentFixture[]) {
  return asMessage({
    messageReference: { type: MessageReferenceType.Forward },
    referencedMessage: asMessage({ attachments }),
  });
}

describe("resolveForwardedMediaList", () => {
  it("downloads forwarded attachments", async () => {
    const attachment = attachmentFixture("att-1", "image.png");
    mockDownload("/tmp/image.png");
    const snapshot = { message: { attachments: [attachment] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectSinglePngDownload({
      result,
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      expectedPath: "/tmp/image.png",
    });
  });

  it("forwards fetchImpl to forwarded attachment downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const attachment = attachmentFixture("att-proxy", "proxy.png");
    mockDownload("/tmp/proxy.png");
    const snapshot = { message: { attachments: [attachment] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = attachmentFixture("att-fallback", "fallback.png");
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const snapshot = { message: { attachments: [attachment] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectAttachmentImageFallback({ result });
  });

  it("downloads forwarded stickers", async () => {
    const sticker = stickerFixture("sticker-1", "wave");
    mockDownload("/tmp/sticker.png");
    const snapshot = { message: { sticker_items: [sticker] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectSinglePngDownload({
      result,
      expectedUrl: "https://media.discordapp.net/stickers/sticker-1.png",
      filePathHint: "wave.png",
      expectedPath: "/tmp/sticker.png",
      kind: "sticker",
    });
  });

  it("returns empty when no snapshots are present", async () => {
    const result = await resolveForwardedMediaList(asMessage({}), 512);

    expect(result).toStrictEqual([]);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("downloads forwarded referenced attachments when snapshots are absent", async () => {
    const attachment = attachmentFixture("att-ref-1", "ref-image.png");
    mockDownload("/tmp/ref-image.png");

    const result = await resolveForwardedMediaList(asReferencedForwardMessage([attachment]), 512);

    expectSinglePngDownload({
      result,
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      expectedPath: "/tmp/ref-image.png",
    });
  });

  it("skips snapshots without attachments", async () => {
    const snapshot = { message: { content: "hello" } };
    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expect(result).toStrictEqual([]);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("passes readIdleTimeoutMs to forwarded attachment downloads", async () => {
    const attachment = attachmentFixture("att-timeout-forwarded", "forwarded-timeout.png");
    mockDownload("/tmp/forwarded-timeout.png");
    const snapshot = { message: { attachments: [attachment] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to forwarded sticker downloads", async () => {
    const sticker = stickerFixture("sticker-timeout-forwarded", "timeout-forwarded");
    mockDownload("/tmp/forwarded-sticker-timeout.png");
    const snapshot = { message: { sticker_items: [sticker] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });
});

describe("resolveMediaList", () => {
  it("downloads media from the configured endpoint origin without redirects", async () => {
    installMediaEndpoint();
    mockDownload("/tmp/provider-media.png");
    const attachment = attachmentFixture("provider-media", "provider-media.png", {
      url: "http://127.0.0.1:43210/media/provider-media.png",
    });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result[0]?.path).toBe("/tmp/provider-media.png");
    expect(fetchParams()).toEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:43210/media/provider-media.png",
        maxRedirects: 0,
        ssrfPolicy: expect.objectContaining({
          allowedOrigins: ["http://127.0.0.1:43210"],
        }),
      }),
    );
  });

  it("rejects public Discord CDN media before the downloader is called", async () => {
    installMediaEndpoint();
    const attachment = attachmentFixture("public-media", "public-media.png");

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result).toEqual([{ contentType: "image/png" }]);
  });

  it("keeps the whole media batch bound to its originating environment value", async () => {
    installMediaEndpoint();
    saveRemoteMedia.mockImplementationOnce(async () => {
      process.env[DISCORD_API_URL_ENV] = "http://127.0.0.1:43211/api/v10";
      return {
        id: "provider-media",
        path: "/tmp/provider-media.png",
        size: 8,
        contentType: "image/png",
      };
    });
    const providerAttachment = attachmentFixture("provider", "provider.png", {
      url: "http://127.0.0.1:43210/media/provider.png",
    });
    const publicAttachment = attachmentFixture("public", "public.png");

    const result = await resolveMediaList(
      asMessage({ attachments: [providerAttachment, publicAttachment] }),
      512,
    );

    expect(saveRemoteMedia).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        path: "/tmp/provider-media.png",
        contentType: "image/png",
        fileName: "provider.png",
      },
      { contentType: "image/png" },
    ]);
  });

  it("downloads stickers", async () => {
    const sticker = stickerFixture("sticker-2", "hello");
    mockDownload("/tmp/sticker-2.png");
    const message = asMessage({ stickers: [sticker] });

    const result = await resolveMediaList(message, 512);

    expectSinglePngDownload({
      result,
      expectedUrl: "https://media.discordapp.net/stickers/sticker-2.png",
      filePathHint: "hello.png",
      expectedPath: "/tmp/sticker-2.png",
      kind: "sticker",
    });
  });

  it("forwards fetchImpl to sticker downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const sticker = stickerFixture("sticker-proxy", "proxy-sticker");
    mockDownload("/tmp/sticker-proxy.png");
    const message = asMessage({ stickers: [sticker] });

    await resolveMediaList(message, 512, { fetchImpl: proxyFetch });

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = attachmentFixture("att-main-fallback", "main-fallback.png");
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expectAttachmentImageFallback({ result });
  });

  it("keeps type-only facts for attachments without a usable URL", async () => {
    const { url: _url, ...attachment } = attachmentFixture("att-missing-url", "voice.ogg", {
      content_type: "audio/ogg",
    });
    const message = asMessage({ attachments: [attachment] });
    const result = await resolveMediaList(message, 512);

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result).toStrictEqual([{ contentType: "audio/ogg", kind: "audio" }]);
  });

  it("classifies audio attachments by filename when content type is missing", async () => {
    const attachment = attachmentFixture("att-audio-fallback", "voice.ogg", {
      content_type: undefined,
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("classifies Discord voice attachments by waveform metadata", async () => {
    const attachment = attachmentFixture("att-voice-metadata", "voice", {
      content_type: undefined,
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("lets native Discord voice metadata override a conflicting definitive MIME", async () => {
    const attachment = attachmentFixture("att-voice-conflicting-mime", "voice", {
      content_type: "video/ogg",
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([{ contentType: undefined, kind: "audio" }]);
  });

  it.each(["application/octet-stream", "application/ogg"])(
    "prefers the structured audio kind over non-audio MIME %s",
    async (contentType) => {
      const attachment = attachmentFixture("att-audio-conflicting-mime", "voice.ogg", {
        content_type: contentType,
      });
      mockDownload("/tmp/voice.ogg", { contentType });

      const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

      expect(result).toEqual([
        {
          path: "/tmp/voice.ogg",
          contentType: undefined,
          fileName: "voice.ogg",
          kind: "audio",
        },
      ]);
    },
  );

  it("normalizes MIME case before classifying audio", async () => {
    const attachment = attachmentFixture("att-audio-mime-case", "voice.bin", {
      content_type: "Audio/OGG",
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "Audio/OGG",
        kind: "audio",
      },
    ]);
  });

  it("does not let an audio-looking filename override video MIME", async () => {
    const attachment = attachmentFixture("att-video-audio-extension", "clip.ogg", {
      content_type: "video/ogg",
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "video/ogg",
      },
    ]);
  });

  it("does not let an audio-looking filename override fetched image MIME", async () => {
    const attachment = attachmentFixture("att-image-audio-extension", "image.ogg", {
      content_type: undefined,
    });
    mockDownload("/tmp/image.png");

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        fileName: "image.ogg",
      },
    ]);
  });

  it("keeps declared audio when the fetched MIME is generic", async () => {
    const attachment = attachmentFixture("att-declared-audio-fetched-generic", "voice", {
      content_type: "audio/ogg",
    });
    mockDownload("/tmp/voice", { contentType: "application/octet-stream" });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/voice",
        contentType: "audio/ogg",
        fileName: "voice",
        kind: "audio",
      },
    ]);
  });

  it.each(["application/pdf", "text/plain"])(
    "does not infer audio from an .ogg filename with definitive MIME %s",
    async (contentType) => {
      const attachment = attachmentFixture(`att-definitive-${contentType}`, "document.ogg", {
        content_type: contentType,
      });
      saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

      const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

      expect(result).toEqual([
        {
          contentType,
        },
      ]);
    },
  );

  it("uses fetched image MIME over declared audio", async () => {
    const attachment = attachmentFixture("att-declared-audio-fetched-image", "voice.ogg", {
      content_type: "audio/ogg",
    });
    mockDownload("/tmp/image.png");

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        fileName: "voice.ogg",
      },
    ]);
  });

  it("classifies extensionless Discord voice attachments from native fields", async () => {
    const attachment = attachmentFixture("att-voice-native-fields", "voice", {
      content_type: undefined,
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("does not classify a duration-bearing video attachment as audio", async () => {
    const attachment = attachmentFixture("att-video-duration", "PXL_2024.mp4", {
      content_type: "video/mp4",
      duration_secs: 11.262232780456543,
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "video/mp4",
      },
    ]);
  });

  it("keeps a fetched video MIME over a declared duration-only attachment", async () => {
    const attachment = attachmentFixture("att-video-duration-fetched", "PXL_2024.mov", {
      content_type: "video/quicktime",
      duration_secs: 5.5,
    });
    mockDownload("/tmp/PXL_2024.mov", { contentType: "video/quicktime" });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/PXL_2024.mov",
        contentType: "video/quicktime",
        fileName: "PXL_2024.mov",
      },
    ]);
  });

  it("keeps an image with a duration field as an image, not audio", async () => {
    const attachment = attachmentFixture("att-image-duration", "photo.png", {
      content_type: "image/png",
      duration_secs: 0.5,
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "image/png",
      },
    ]);
  });

  it("keeps a type-only fact when media storage fails", async () => {
    const attachment = attachmentFixture("att-save-fail", "photo.png");
    saveRemoteMedia.mockRejectedValueOnce(new Error("disk full"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        contentType: "image/png",
      },
    ]);
  });

  it("preserves downloaded attachments alongside failed ones", async () => {
    const goodAttachment = attachmentFixture("att-good", "good.png");
    const badAttachment = attachmentFixture("att-bad", "bad.pdf", {
      content_type: "application/pdf",
    });

    mockDownload("/tmp/good.png");
    saveRemoteMedia.mockRejectedValueOnce(new Error("network timeout"));
    const message = asMessage({ attachments: [goodAttachment, badAttachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        path: "/tmp/good.png",
        contentType: "image/png",
        fileName: "good.png",
      },
      {
        contentType: "application/pdf",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = stickerFixture("sticker-fallback", "fallback");
    saveRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ stickers: [sticker] });

    const result = await resolveMediaList(message, 512);

    expect(saveRemoteMedia).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        contentType: "image/png",
        kind: "sticker",
      },
    ]);
  });

  it("passes readIdleTimeoutMs to saveRemoteMedia for attachments", async () => {
    const attachment = attachmentFixture("att-timeout", "timeout.png");
    mockDownload("/tmp/timeout.png");
    const message = asMessage({ attachments: [attachment] });

    await resolveMediaList(message, 512, { readIdleTimeoutMs: 60_000 });

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to saveRemoteMedia for stickers", async () => {
    const sticker = stickerFixture("sticker-timeout", "timeout");
    mockDownload("/tmp/sticker-timeout.png");
    const message = asMessage({ stickers: [sticker] });

    await resolveMediaList(message, 512, { readIdleTimeoutMs: 60_000 });

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("times out slow attachment downloads and returns a type-only fact", async () => {
    const attachment = attachmentFixture("att-total-timeout", "slow.png");
    const message = asMessage({ attachments: [attachment] });
    vi.useFakeTimers();
    saveRemoteMedia.mockImplementation(
      () =>
        new Promise<never>(() => {
          // never resolves
        }),
    );

    try {
      const resultPromise = resolveMediaList(message, 512, { totalTimeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toEqual([
        {
          contentType: "image/png",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes abortSignal to saveRemoteMedia and keeps a type-only fact when aborted", async () => {
    const attachment = attachmentFixture("att-abort", "abort.png");
    const message = asMessage({ attachments: [attachment] });
    const abortController = new AbortController();
    saveRemoteMedia.mockImplementationOnce(
      (params) =>
        new Promise<never>((_, reject) => {
          const signal = params.requestInit?.signal;
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          if (signal?.aborted) {
            reject(abortError);
            return;
          }
          signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    );

    const resultPromise = resolveMediaList(message, 512, {
      abortSignal: abortController.signal,
    });
    abortController.abort();

    await expect(resultPromise).resolves.toEqual([
      {
        contentType: "image/png",
      },
    ]);
    expect(fetchParams().requestInit?.signal).toBe(abortController.signal);
  });
});
