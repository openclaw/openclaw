import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

vi.mock("./utils/debug-log.js", () => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
}));

import { MediaFileType, uploadC2CMedia, uploadGroupMedia } from "./api.js";

describe("qqbot direct upload SSRF guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "cdn.qpic.cn",
      addresses: ["203.0.113.10"],
      lookup: vi.fn(),
    });
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ file_uuid: "uuid", file_info: "info", ttl: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: async () => {},
    });
  });

  it("blocks direct-upload URLs that are outside the QQ Bot media allowlist", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("Blocked hostname (not in allowlist): example.com"),
    );

    await expect(
      uploadC2CMedia(
        "access-token",
        "user-1",
        MediaFileType.IMAGE,
        "https://example.com/payload.png",
      ),
    ).rejects.toThrow("Blocked hostname");

    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("blocks non-HTTPS direct-upload URLs before the QQ upload request", async () => {
    await expect(
      uploadGroupMedia(
        "access-token",
        "group-1",
        MediaFileType.FILE,
        "http://cdn.qpic.cn/payload.txt",
      ),
    ).rejects.toThrow("Direct-upload media URL must use HTTPS");

    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("allows QQ-approved HTTPS direct-upload URLs", async () => {
    const result = await uploadC2CMedia(
      "access-token",
      "user-1",
      MediaFileType.IMAGE,
      "https://cdn.qpic.cn/payload.png",
    );

    expect(result).toEqual({ file_uuid: "uuid", file_info: "info", ttl: 3600 });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("cdn.qpic.cn", {
      policy: expect.objectContaining({
        hostnameAllowlist: expect.arrayContaining(["*.qpic.cn"]),
      }),
    });
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });
});
