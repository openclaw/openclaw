import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { expect, it, vi, beforeEach } from "vitest";
import { uploadFile } from "../tlon-api.js";
import { uploadImageFromUrl } from "./upload.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
}));
vi.mock("../tlon-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tlon-api.js")>()),
  uploadFile: vi.fn(),
}));
const mockReadRemoteMediaBuffer = vi.mocked(readRemoteMediaBuffer);
const mockUploadFile = vi.mocked(uploadFile);
const clientConfig = {
  shipUrl: "https://zod.tlon.network",
  shipName: "zod",
  getCode: async () => "fixture-code",
};
const uploadedUrl = "https://memex.tlon.network/uploaded.png";
const imageUrl = "https://example.com/image.png";
const buffer = Buffer.from("fake-image");
const upload = (url = imageUrl, cap?: number) => uploadImageFromUrl(url, clientConfig, cap);
function setupSuccessfulUpload(contentType = "image/png", fileName?: string) {
  mockReadRemoteMediaBuffer.mockResolvedValue({ buffer, contentType, fileName });
  mockUploadFile.mockResolvedValue({ url: uploadedUrl });
}
beforeEach(() => vi.clearAllMocks());
it.each([1024, MAX_IMAGE_BYTES * 2])("caps downloads at %s bytes", async (cap) => {
  setupSuccessfulUpload("image/jpeg");
  const url = "https://example.com/path/to/my-image.jpg";
  await expect(upload(url, cap)).resolves.toBe(uploadedUrl);
  expect(mockReadRemoteMediaBuffer.mock.lastCall?.[0]).toMatchObject({
    url,
    maxBytes: Math.min(cap ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
    responseHeaderTimeoutMs: 120_000,
    readIdleTimeoutMs: 30_000,
  });
  expect(mockUploadFile).toHaveBeenCalledTimes(1);
  const params = mockUploadFile.mock.lastCall?.[0];
  expect(params).toMatchObject({
    blob: expect.any(Blob),
    contentType: "image/jpeg",
    fileName: "my-image.jpg",
  });
  await expect(params?.blob.arrayBuffer()).resolves.toEqual(Uint8Array.from(buffer).buffer);
});

it.each([
  ["https://example.com/download?id=123", "photo#1.png", /^photo#1\.png$/],
  ["https://example.com/", undefined, /^upload-\d+\.png$/],
] as const)("selects the upload filename for %s", async (url, fileName, expected) => {
  setupSuccessfulUpload("image/png", fileName);
  await upload(url);
  expect(mockUploadFile.mock.lastCall?.[0].fileName).toMatch(expected);
});

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
  const config = { ...clientConfig, assertDirectAdapterHandoff };
  await expect(uploadImageFromUrl(imageUrl, config)).rejects.toBe(revoked);
  expect(mockUploadFile).not.toHaveBeenCalled();
});

it("does not embed an unchecked URL when a configured cap rejects its bytes", async () => {
  const error = new Error("payload exceeds maxBytes 1024");
  mockReadRemoteMediaBuffer.mockRejectedValue(error);
  await expect(upload(imageUrl, 1024)).rejects.toBe(error);
  expect(mockUploadFile).not.toHaveBeenCalled();
});

it("rejects non-http(s) URLs", async () => {
  await expect(upload("file:///etc/passwd")).resolves.toBe("file:///etc/passwd");
  expect(mockReadRemoteMediaBuffer).not.toHaveBeenCalled();
});
