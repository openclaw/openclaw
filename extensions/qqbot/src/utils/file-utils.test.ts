import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediaRuntimeMocks = vi.hoisted(() => ({
  fetchRemoteMedia: vi.fn(),
}));

const ssrfRuntimeMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  fetchRemoteMedia: (...args: unknown[]) => mediaRuntimeMocks.fetchRemoteMedia(...args),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: (...args: unknown[]) =>
    ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy(...args),
}));

import {
  QQBOT_MEDIA_SSRF_POLICY,
  downloadFile,
  resolveApprovedQqbotRemoteMediaUrl,
} from "./file-utils.js";

describe("qqbot file-utils downloadFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    mediaRuntimeMocks.fetchRemoteMedia.mockReset();
    ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy.mockReset();
    ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "media.qq.com",
      addresses: ["203.0.113.10"],
      lookup: vi.fn(),
    });
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqbot-file-utils-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("downloads through the guarded media runtime with the qqbot SSRF policy", async () => {
    mediaRuntimeMocks.fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "remote.png",
    });

    const savedPath = await downloadFile(
      "https://media.qq.com/assets/photo.png",
      tempDir,
      "photo.png",
    );

    expect(savedPath).toBeTruthy();
    expect(savedPath).toMatch(/photo_\d+_[0-9a-f]{6}\.png$/);
    expect(await fs.promises.readFile(savedPath!, "utf8")).toBe("image-bytes");
    expect(ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("media.qq.com", {
      policy: QQBOT_MEDIA_SSRF_POLICY,
    });
    expect(mediaRuntimeMocks.fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      ssrfPolicy: QQBOT_MEDIA_SSRF_POLICY,
    });
    expect(QQBOT_MEDIA_SSRF_POLICY).toEqual({
      hostnameAllowlist: ["*.myqcloud.com", "*.qpic.cn", "*.qq.com", "*.tencentcos.com"],
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("rejects non-HTTPS URLs before attempting a fetch", async () => {
    const savedPath = await downloadFile("http://media.qq.com/assets/photo.png", tempDir);

    expect(savedPath).toBeNull();
    expect(ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(mediaRuntimeMocks.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("returns an approved normalized URL only after SSRF policy validation", async () => {
    const approvedUrl = await resolveApprovedQqbotRemoteMediaUrl(
      "https://media.qq.com/assets/photo.png?x=1",
    );

    expect(approvedUrl).toBe("https://media.qq.com/assets/photo.png?x=1");
    expect(ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("media.qq.com", {
      policy: QQBOT_MEDIA_SSRF_POLICY,
    });
  });

  it("rejects URLs when hostname validation fails", async () => {
    ssrfRuntimeMocks.resolvePinnedHostnameWithPolicy.mockRejectedValue(new Error("blocked"));

    const approvedUrl = await resolveApprovedQqbotRemoteMediaUrl(
      "https://example.com/assets/photo.png",
    );
    const savedPath = await downloadFile("https://example.com/assets/photo.png", tempDir);

    expect(approvedUrl).toBeNull();
    expect(savedPath).toBeNull();
    expect(mediaRuntimeMocks.fetchRemoteMedia).not.toHaveBeenCalled();
  });
});
