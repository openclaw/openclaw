// Qqbot tests cover media plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFileType, type UploadMediaResponse } from "../types.js";
import { MAX_UPLOAD_SIZE } from "../utils/file-utils.js";
import { ApiClient } from "./api-client.js";
import { downloadDirectUploadUrl, MediaApi } from "./media.js";
import { TokenManager } from "./token.js";

type LookupFn = NonNullable<Parameters<typeof downloadDirectUploadUrl>[1]>["lookupFn"];

const readResponseWithLimitMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/response-limit-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/response-limit-runtime")>();
  return {
    ...actual,
    readResponseWithLimit: readResponseWithLimitMock,
  };
});

const UPLOAD_RESPONSE: UploadMediaResponse = {
  file_uuid: "uuid-1",
  file_info: "file-info-1",
  ttl: 3600,
};

const MEDIA_BYTES = Buffer.from("downloaded-media");
const MEDIA_BASE64 = MEDIA_BYTES.toString("base64");

function mockNativeResponse(body: BodyInit = MEDIA_BYTES, init?: ResponseInit): Response {
  const response = new Response(body, init);
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  return response;
}

function mockApiClient(): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, "request").mockResolvedValue(UPLOAD_RESPONSE);
  return client;
}

function mockTokenManager(): TokenManager {
  const tokenManager = new TokenManager();
  vi.spyOn(tokenManager, "getAccessToken").mockResolvedValue("token-1");
  return tokenManager;
}

function expectNativeDownload(url: string): void {
  expect(globalThis.fetch).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
  const signal = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
}

describe("MediaApi.uploadMedia direct URL uploads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readResponseWithLimitMock.mockReset();
    readResponseWithLimitMock.mockResolvedValue(MEDIA_BYTES);
    mockNativeResponse();
  });

  it.each([
    { fileType: MediaFileType.IMAGE, url: "https://cdn.example.com/assets/photo.png" },
    { fileType: MediaFileType.VIDEO, url: "http://cdn.example.com/assets/video.mp4" },
    { fileType: MediaFileType.FILE, url: "http://cdn.example.com/assets/report.pdf" },
  ])("downloads public HTTP(S) $fileType URLs with native fetch", async ({ fileType, url }) => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    const result = await api.uploadMedia(
      "c2c",
      "user-openid",
      fileType,
      { appId: "app-id", clientSecret: "client-secret" },
      { url },
    );

    expect(result).toBe(UPLOAD_RESPONSE);
    expectNativeDownload(url);
    expect(readResponseWithLimitMock).toHaveBeenCalledWith(expect.any(Response), MAX_UPLOAD_SIZE, {
      chunkTimeoutMs: 10_000,
    });
    expect(tokenManager["getAccessToken"]).toHaveBeenCalledWith("app-id", "client-secret");
    expect(client["request"]).toHaveBeenCalledWith(
      "token-1",
      "POST",
      expect.any(String),
      {
        file_type: fileType,
        srv_send_msg: false,
        file_data: MEDIA_BASE64,
      },
      {
        redactBodyKeys: ["file_data"],
        uploadRequest: true,
      },
    );
  });

  it("uses native fetch no-redirect behavior when downloading media", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.IMAGE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "https://cdn.example.com/assets/photo.png" },
    );

    expectNativeDownload("https://cdn.example.com/assets/photo.png");
  });

  it("rejects redirects before reading media URL bodies", async () => {
    vi.restoreAllMocks();
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1/private.png" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectResponse);
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://cdn.example.com/assets/photo.png" },
      ),
    ).rejects.toThrow("Direct-upload media URL returned HTTP 302");

    expectNativeDownload("https://cdn.example.com/assets/photo.png");
    expect(readResponseWithLimitMock).not.toHaveBeenCalled();
    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("bounds stalled native fetch setup before reading URL bodies", async () => {
    vi.useFakeTimers();
    try {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(() => {}));
      const client = mockApiClient();
      const tokenManager = mockTokenManager();
      const api = new MediaApi(client, tokenManager);

      const uploadPromise = api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://slow-dns.example.com/assets/photo.png" },
      );
      const rejection = expect(uploadPromise).rejects.toThrow(
        "Direct-upload media URL fetch timed out",
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(readResponseWithLimitMock).not.toHaveBeenCalled();
      expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
      expect(client["request"]).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects URL bodies that keep trickling under the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      mockNativeResponse();
      readResponseWithLimitMock.mockReset();
      readResponseWithLimitMock.mockImplementationOnce(() => new Promise<Buffer>(() => {}));
      const client = mockApiClient();
      const tokenManager = mockTokenManager();
      const api = new MediaApi(client, tokenManager);

      const uploadPromise = api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://cdn.example.com/assets/slow.bin" },
      );

      for (let i = 0; i < 5 && readResponseWithLimitMock.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(readResponseWithLimitMock).toHaveBeenCalledOnce();

      const rejection = expect(uploadPromise).rejects.toThrow(
        "Direct-upload media URL body timed out",
      );
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes downloaded URL media through the base64 upload cache", async () => {
    const cache = {
      computeHash: vi.fn(() => "hash-1"),
      get: vi.fn(() => "cached-file-info"),
      set: vi.fn(),
    };
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager, { uploadCache: cache });

    const result = await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.IMAGE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "https://cdn.example.com/assets/photo.png" },
    );

    expect(result).toEqual({ file_uuid: "", file_info: "cached-file-info", ttl: 0 });
    expect(cache.computeHash).toHaveBeenCalledWith(MEDIA_BASE64);
    expect(cache.get).toHaveBeenCalledWith("hash-1", "c2c", "user-openid", MediaFileType.IMAGE);
    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("does not reuse cached FILE uploads when the requested filename differs", async () => {
    const cache = {
      computeHash: vi.fn(() => "hash-1"),
      get: vi.fn(() => "cached-file-info"),
      set: vi.fn(),
    };
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager, {
      uploadCache: cache,
      sanitizeFileName: (name) => `safe-${name}`,
    });

    await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.FILE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "https://cdn.example.com/report.pdf", fileName: "report.pdf" },
    );

    expect(cache.computeHash).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(client["request"]).toHaveBeenCalledWith(
      "token-1",
      "POST",
      expect.any(String),
      expect.objectContaining({
        file_data: MEDIA_BASE64,
        file_name: "safe-report.pdf",
      }),
      expect.any(Object),
    );
  });

  it("rejects invalid direct-upload URLs before downloading media or calling the QQ API", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "not a url" },
      ),
    ).rejects.toThrow("Direct-upload media URL must be a valid URL");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP direct-upload URLs before downloading media or calling the QQ API", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "ftp://media.qq.com/assets/photo.png" },
      ),
    ).rejects.toThrow("Direct-upload media URL must use HTTP or HTTPS");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1"])(
    "does not upload direct URLs rejected by literal host validation: %s",
    async (host) => {
      vi.restoreAllMocks();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
      const client = mockApiClient();
      const tokenManager = mockTokenManager();
      const api = new MediaApi(client, tokenManager);

      await expect(
        api.uploadMedia(
          "group",
          "group-openid",
          MediaFileType.IMAGE,
          { appId: "app-id", clientSecret: "client-secret" },
          { url: `https://${host}/latest/meta-data/` },
        ),
      ).rejects.toThrow("Blocked hostname");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
      expect(client["request"]).not.toHaveBeenCalled();
    },
  );

  it("rejects direct URL hosts that resolve to private addresses before fetch", async () => {
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    const lookupFn: LookupFn = async () => ({
      address: "127.0.0.1",
      family: 4,
    });

    await expect(
      downloadDirectUploadUrl("https://cdn.example.com/assets/photo.png", { lookupFn }),
    ).rejects.toThrow("resolves to private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not forward URLs when the native download fails", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("download failed"));
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "group",
        "group-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://attacker.example/latest/meta-data/" },
      ),
    ).rejects.toThrow("download failed");

    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("rejects literal RFC 2544 special-use URL hosts before native download", async () => {
    vi.restoreAllMocks();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://198.18.0.42/assets/photo.png" },
      ),
    ).rejects.toThrow("Blocked hostname");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("keeps public literal IP URLs on the native download path", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.IMAGE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "http://93.184.216.34/assets/photo.png" },
    );

    expectNativeDownload("http://93.184.216.34/assets/photo.png");
  });

  it("does not pass URL or fake-IP DNS policy to the QQ upload body", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.IMAGE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "https://cdn.example.com/assets/photo.png" },
    );

    expectNativeDownload("https://cdn.example.com/assets/photo.png");
    expect(client["request"]).toHaveBeenCalledWith(
      "token-1",
      "POST",
      expect.any(String),
      expect.objectContaining({
        file_data: MEDIA_BASE64,
      }),
      expect.any(Object),
    );
    expect(client["request"]).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ url: expect.any(String) }),
      expect.any(Object),
    );
  });

  it("rejects HTTP errors from native direct-upload downloads before calling the QQ API", async () => {
    vi.restoreAllMocks();
    mockNativeResponse("not found", { status: 404 });
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://cdn.example.com/missing.png" },
      ),
    ).rejects.toThrow("Direct-upload media URL returned HTTP 404");

    expect(tokenManager["getAccessToken"]).not.toHaveBeenCalled();
    expect(client["request"]).not.toHaveBeenCalled();
  });
});
