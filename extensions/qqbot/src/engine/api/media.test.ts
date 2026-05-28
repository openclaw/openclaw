import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFileType, type UploadMediaResponse } from "../types.js";
import { MAX_UPLOAD_SIZE } from "../utils/file-utils.js";
import { ApiClient } from "./api-client.js";
import { MediaApi } from "./media.js";
import { TokenManager } from "./token.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const readResponseWithLimitMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/response-limit-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/response-limit-runtime")>();
  return {
    ...actual,
    readResponseWithLimit: readResponseWithLimitMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

const UPLOAD_RESPONSE: UploadMediaResponse = {
  file_uuid: "uuid-1",
  file_info: "file-info-1",
  ttl: 3600,
};

const MEDIA_BYTES = Buffer.from("downloaded-media");
const MEDIA_BASE64 = MEDIA_BYTES.toString("base64");

function mockGuardedResponse(
  body: BodyInit = MEDIA_BYTES,
  init?: ResponseInit,
): {
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(body, init),
    release,
  });
  return { release };
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

describe("MediaApi.uploadMedia direct URL uploads", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    readResponseWithLimitMock.mockReset();
    readResponseWithLimitMock.mockResolvedValue(MEDIA_BYTES);
    mockGuardedResponse();
  });

  it.each([
    { fileType: MediaFileType.IMAGE, url: "https://cdn.example.com/assets/photo.png" },
    { fileType: MediaFileType.VIDEO, url: "http://cdn.example.com/assets/video.mp4" },
    { fileType: MediaFileType.FILE, url: "http://cdn.example.com/assets/report.pdf" },
  ])(
    "downloads public HTTP(S) $fileType URLs through the pinned SSRF guard",
    async ({ fileType, url }) => {
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
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url,
        maxRedirects: 0,
        timeoutMs: 30_000,
      });
      expect(readResponseWithLimitMock).toHaveBeenCalledWith(
        expect.any(Response),
        MAX_UPLOAD_SIZE,
        { chunkTimeoutMs: 10_000 },
      );
      expect(tokenManager.getAccessToken).toHaveBeenCalledWith("app-id", "client-secret");
      expect(client.request).toHaveBeenCalledWith(
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
    },
  );

  it("releases the pinned SSRF dispatcher after downloading media", async () => {
    fetchWithSsrFGuardMock.mockReset();
    const { release } = mockGuardedResponse();
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

    expect(release).toHaveBeenCalledTimes(1);
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
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
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

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
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

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1"])(
    "does not upload direct URLs rejected by the SSRF guard: %s",
    async (host) => {
      fetchWithSsrFGuardMock.mockReset();
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

      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("does not forward URLs when the guarded download fails", async () => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal/special-use IP address"),
    );
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
    ).rejects.toThrow("resolves to private");

    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects literal RFC 2544 special-use URL hosts through the guarded download", async () => {
    fetchWithSsrFGuardMock.mockReset();
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

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("keeps public literal IP URLs on the default SSRF policy", async () => {
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

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "http://93.184.216.34/assets/photo.png",
      maxRedirects: 0,
      timeoutMs: 30_000,
    });
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

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://cdn.example.com/assets/photo.png",
      maxRedirects: 0,
      timeoutMs: 30_000,
    });
    expect(client.request).toHaveBeenCalledWith(
      "token-1",
      "POST",
      expect.any(String),
      expect.objectContaining({
        file_data: MEDIA_BASE64,
      }),
      expect.any(Object),
    );
    expect(client.request).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ url: expect.any(String) }),
      expect.any(Object),
    );
  });

  it("rejects HTTP errors from guarded direct-upload downloads before calling the QQ API", async () => {
    fetchWithSsrFGuardMock.mockReset();
    mockGuardedResponse("not found", { status: 404 });
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

    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});
