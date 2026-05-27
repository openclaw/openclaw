import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFileType, type UploadMediaResponse } from "../types.js";
import { QQBOT_MEDIA_SSRF_POLICY } from "../utils/file-utils.js";
import type { ApiClient } from "./api-client.js";
import { MediaApi } from "./media.js";
import type { TokenManager } from "./token.js";

const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

const UPLOAD_RESPONSE: UploadMediaResponse = {
  file_uuid: "uuid-1",
  file_info: "file-info-1",
  ttl: 3600,
};

function mockApiClient(): ApiClient & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn().mockResolvedValue(UPLOAD_RESPONSE),
  } as unknown as ApiClient & { request: ReturnType<typeof vi.fn> };
}

function mockTokenManager(): TokenManager & { getAccessToken: ReturnType<typeof vi.fn> } {
  return {
    getAccessToken: vi.fn().mockResolvedValue("token-1"),
  } as unknown as TokenManager & { getAccessToken: ReturnType<typeof vi.fn> };
}

describe("MediaApi.uploadMedia direct URL uploads", () => {
  beforeEach(() => {
    resolvePinnedHostnameWithPolicyMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "media.qq.com",
      addresses: ["203.0.113.10"],
      lookup: vi.fn(),
    });
  });

  it.each([MediaFileType.IMAGE, MediaFileType.VIDEO, MediaFileType.FILE])(
    "validates %s URL uploads with the QQBot media SSRF policy",
    async (fileType) => {
      const client = mockApiClient();
      const tokenManager = mockTokenManager();
      const api = new MediaApi(client, tokenManager);

      const result = await api.uploadMedia(
        "c2c",
        "user-openid",
        fileType,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "https://media.qq.com/assets/photo.png" },
      );

      expect(result).toBe(UPLOAD_RESPONSE);
      expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("media.qq.com", {
        policy: QQBOT_MEDIA_SSRF_POLICY,
      });
      expect(tokenManager.getAccessToken).toHaveBeenCalledWith("app-id", "client-secret");
      expect(client.request).toHaveBeenCalledWith(
        "token-1",
        "POST",
        expect.any(String),
        {
          file_type: fileType,
          srv_send_msg: false,
          url: "https://media.qq.com/assets/photo.png",
        },
        {
          redactBodyKeys: ["file_data"],
          uploadRequest: true,
        },
      );
    },
  );

  it("rejects non-HTTPS direct-upload URLs before calling the QQ API", async () => {
    const client = mockApiClient();
    const tokenManager = mockTokenManager();
    const api = new MediaApi(client, tokenManager);

    await expect(
      api.uploadMedia(
        "c2c",
        "user-openid",
        MediaFileType.IMAGE,
        { appId: "app-id", clientSecret: "client-secret" },
        { url: "http://media.qq.com/assets/photo.png" },
      ),
    ).rejects.toThrow("Direct-upload media URL must use HTTPS");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not forward direct-upload URLs rejected by the SSRF policy", async () => {
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname (not in allowlist): 169.254.169.254"),
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
        { url: "https://169.254.169.254/latest/meta-data/" },
      ),
    ).rejects.toThrow("Blocked hostname");

    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("169.254.169.254", {
      policy: QQBOT_MEDIA_SSRF_POLICY,
    });
    expect(tokenManager.getAccessToken).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});
