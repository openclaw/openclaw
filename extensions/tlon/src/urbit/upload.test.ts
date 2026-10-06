import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { uploadFile } from "../tlon-api.js";
import { uploadImageFromUrl } from "./upload.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
}));

vi.mock("../tlon-api.js", () => ({
  uploadFile: vi.fn(),
}));

const mockReadRemoteMediaBuffer = vi.mocked(readRemoteMediaBuffer);
const mockUploadFile = vi.mocked(uploadFile);
const clientConfig = {
  shipUrl: "https://zod.tlon.network",
  shipName: "zod",
  verbose: false,
  getCode: async () => "fixture-code",
};

async function setupSuccessfulUpload(params?: { contentType?: string; uploadedUrl?: string }) {
  const contentType = params?.contentType ?? "image/png";
  const buffer = Buffer.from("fake-image");
  mockReadRemoteMediaBuffer.mockResolvedValue({
    buffer,
    contentType,
    fileName: "image.png",
  });
  if (params?.uploadedUrl) {
    mockUploadFile.mockResolvedValue({ url: params.uploadedUrl });
  }
  return { buffer };
}

function requireUploadParams(): { blob?: Blob; contentType?: string; fileName?: string } {
  const [call] = mockUploadFile.mock.calls;
  if (!call) {
    throw new Error("expected Tlon uploadFile call");
  }
  const [uploadParams] = call;
  if (!uploadParams || typeof uploadParams !== "object" || Array.isArray(uploadParams)) {
    throw new Error("expected Tlon uploadFile params");
  }
  return uploadParams as { blob?: Blob; contentType?: string; fileName?: string };
}

describe("uploadImageFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([undefined, 1024, MAX_IMAGE_BYTES * 2])(
    "uploads with the effective configured cap %s",
    async (cap) => {
      const { buffer } = await setupSuccessfulUpload({
        uploadedUrl: "https://memex.tlon.network/uploaded.png",
        contentType: "image/jpeg",
      });

      const result = await uploadImageFromUrl(
        "https://example.com/path/to/my-image.jpg",
        clientConfig,
        cap,
      );

      expect(result).toBe("https://memex.tlon.network/uploaded.png");
      expect(mockReadRemoteMediaBuffer).toHaveBeenCalledWith({
        url: "https://example.com/path/to/my-image.jpg",
        maxBytes: Math.min(cap ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
        responseHeaderTimeoutMs: 120_000,
        readIdleTimeoutMs: 30_000,
        ssrfPolicy: undefined,
        beforeRequest: undefined,
        requestInit: { method: "GET" },
      });
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const uploadParams = requireUploadParams();
      expect(uploadParams.contentType).toBe("image/jpeg");
      expect(uploadParams.fileName).toBe("my-image.jpg");
      const blob = uploadParams.blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(Buffer.from(await blob!.arrayBuffer())).toEqual(buffer);
    },
  );

  it("preserves a wrapped authority rejection instead of falling back to the original URL", async () => {
    const revoked = new Error("delivery revoked");
    const assertDirectAdapterHandoff = vi.fn().mockImplementationOnce(() => {
      throw revoked;
    });
    mockReadRemoteMediaBuffer.mockImplementationOnce(async ({ beforeRequest }) => {
      try {
        beforeRequest?.();
      } catch (cause) {
        throw new Error("media fetch failed", { cause });
      }
      throw new Error("expected authority rejection");
    });

    await expect(
      uploadImageFromUrl("https://example.com/image.png", {
        ...clientConfig,
        assertDirectAdapterHandoff,
      }),
    ).rejects.toBe(revoked);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(assertDirectAdapterHandoff).toHaveBeenCalledTimes(1);
  });

  it("does not embed an unchecked URL when a configured cap rejects its bytes", async () => {
    const error = new Error("payload exceeds maxBytes 1024");
    mockReadRemoteMediaBuffer.mockRejectedValue(error);
    await expect(
      uploadImageFromUrl("https://example.com/image.png", clientConfig, 1024),
    ).rejects.toBe(error);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("returns original URL when the remote image exceeds the image cap", async () => {
    mockReadRemoteMediaBuffer.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/image.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await uploadImageFromUrl("https://example.com/image.png", clientConfig);

    expect(result).toBe("https://example.com/image.png");
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("retains the bounded original URL if upload fails with a configured cap", async () => {
    await setupSuccessfulUpload();
    mockUploadFile.mockRejectedValue(new Error("Upload failed"));

    const result = await uploadImageFromUrl("https://example.com/image.png", clientConfig, 1024);

    expect(result).toBe("https://example.com/image.png");
  });

  it("rejects non-http(s) URLs", async () => {
    const result = await uploadImageFromUrl("file:///etc/passwd", clientConfig);
    expect(result).toBe("file:///etc/passwd");

    const result2 = await uploadImageFromUrl("ftp://example.com/image.png", clientConfig);
    expect(result2).toBe("ftp://example.com/image.png");
    expect(mockReadRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("handles invalid URLs gracefully", async () => {
    const result = await uploadImageFromUrl("not-a-valid-url", clientConfig);
    expect(result).toBe("not-a-valid-url");
    expect(mockReadRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("uses default filename when URL has no path", async () => {
    await setupSuccessfulUpload({
      contentType: "image/png",
    });
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });

    await uploadImageFromUrl("https://example.com/", clientConfig);

    expect(requireUploadParams().fileName).toMatch(/^upload-\d+\.png$/);
  });
});
