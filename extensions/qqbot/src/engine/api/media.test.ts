import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFileType, type UploadMediaResponse } from "../types.js";
import { ApiClient } from "./api-client.js";
import { MediaApi } from "./media.js";
import { TokenManager } from "./token.js";

const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

async function useRealSsrfResolverOnce(): Promise<void> {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  resolvePinnedHostnameWithPolicyMock.mockImplementationOnce(
    actual.resolvePinnedHostnameWithPolicy,
  );
}

const UPLOAD_RESPONSE: UploadMediaResponse = {
  file_uuid: "uuid-1",
  file_info: "file-info-1",
  ttl: 3600,
};

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
    resolvePinnedHostnameWithPolicyMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "cdn.example.com",
      addresses: ["203.0.113.10"],
      lookup: vi.fn(),
    });
  });

  it.each([
    { fileType: MediaFileType.IMAGE, url: "https://cdn.example.com/assets/photo.png" },
    { fileType: MediaFileType.VIDEO, url: "http://cdn.example.com/assets/video.mp4" },
    { fileType: MediaFileType.FILE, url: "http://cdn.example.com/assets/report.pdf" },
  ])(
    "preserves public HTTP(S) $fileType URL uploads with the generic SSRF guard",
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
      expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("cdn.example.com", {
        policy: {},
      });
      expect(tokenManager.getAccessToken).toHaveBeenCalledWith("app-id", "client-secret");
      expect(client.request).toHaveBeenCalledWith(
        "token-1",
        "POST",
        expect.any(String),
        {
          file_type: fileType,
          srv_send_msg: false,
          url,
        },
        {
          redactBodyKeys: ["file_data"],
          uploadRequest: true,
        },
      );
    },
  );

  it("rejects invalid direct-upload URLs before calling the QQ API", async () => {
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

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP direct-upload URLs before calling the QQ API", async () => {
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

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1"])(
    "does not forward direct-upload URLs rejected by the SSRF guard: %s",
    async (host) => {
      resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
        new Error("Blocked hostname or private/internal/special-use IP address"),
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
          { url: `https://${host}/latest/meta-data/` },
        ),
      ).rejects.toThrow("Blocked hostname");

      expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith(host, {
        policy: {},
      });
      expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("allows public direct-upload addresses under the real SSRF resolver", async () => {
    await useRealSsrfResolverOnce();
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    const result = await api.uploadMedia(
      "c2c",
      "user-openid",
      MediaFileType.IMAGE,
      { appId: "app-id", clientSecret: "client-secret" },
      { url: "http://93.184.216.34/assets/photo.png" },
    );

    expect(result).toBe(UPLOAD_RESPONSE);
    expect(client.request).toHaveBeenCalledWith(
      "token-1",
      "POST",
      expect.any(String),
      {
        file_type: MediaFileType.IMAGE,
        srv_send_msg: false,
        url: "http://93.184.216.34/assets/photo.png",
      },
      {
        redactBodyKeys: ["file_data"],
        uploadRequest: true,
      },
    );
  });

  it("blocks private direct-upload addresses under the real SSRF resolver", async () => {
    await useRealSsrfResolverOnce();
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "group",
        "group-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://127.0.0.1/latest/meta-data/" },
      ),
    ).rejects.toThrow("Blocked hostname");

    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not forward direct-upload hostnames rejected by the SSRF guard", async () => {
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
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

    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("attacker.example", {
      policy: {},
    });
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects literal RFC 2544 special-use URL hosts under the real SSRF resolver", async () => {
    await useRealSsrfResolverOnce();
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

    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects bracketed IPv4-mapped literal RFC 2544 URL hosts under the real SSRF resolver", async () => {
    await useRealSsrfResolverOnce();
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://[::ffff:198.18.0.42]/assets/photo.png" },
      ),
    ).rejects.toThrow("Blocked hostname");

    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects hostname DNS answers in the RFC 2544 fake-IP range", async () => {
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );
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
    ).rejects.toThrow("Blocked hostname");

    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("cdn.example.com", {
      policy: {},
    });
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});
