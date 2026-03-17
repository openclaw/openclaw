import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
vi.mock("openclaw/plugin-sdk/tlon", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn()
  };
});
vi.mock("@tloncorp/api", () => ({
  uploadFile: vi.fn()
}));
describe("uploadImageFromUrl", () => {
  async function loadUploadMocks() {
    const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/tlon");
    const { uploadFile } = await import("@tloncorp/api");
    const { uploadImageFromUrl } = await import("./upload.js");
    return {
      mockFetch: vi.mocked(fetchWithSsrFGuard),
      mockUploadFile: vi.mocked(uploadFile),
      uploadImageFromUrl
    };
  }
  function mockSuccessfulFetch(params) {
    params.mockFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": params.contentType }),
        blob: () => Promise.resolve(params.blob)
      },
      finalUrl: params.finalUrl,
      release: vi.fn().mockResolvedValue(void 0)
    });
  }
  async function setupSuccessfulUpload(params) {
    const { mockFetch, mockUploadFile, uploadImageFromUrl } = await loadUploadMocks();
    const sourceUrl = params?.sourceUrl ?? "https://example.com/image.png";
    const contentType = params?.contentType ?? "image/png";
    const mockBlob = new Blob(["fake-image"], { type: contentType });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: sourceUrl,
      contentType
    });
    if (params?.uploadedUrl) {
      mockUploadFile.mockResolvedValue({ url: params.uploadedUrl });
    }
    return { mockBlob, mockUploadFile, uploadImageFromUrl };
  }
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("fetches image and calls uploadFile, returns uploaded URL", async () => {
    const { mockBlob, mockUploadFile, uploadImageFromUrl } = await setupSuccessfulUpload({
      uploadedUrl: "https://memex.tlon.network/uploaded.png"
    });
    const result = await uploadImageFromUrl("https://example.com/image.png");
    expect(result).toBe("https://memex.tlon.network/uploaded.png");
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        blob: mockBlob,
        contentType: "image/png"
      })
    );
  });
  it("returns original URL if fetch fails", async () => {
    const { mockFetch, uploadImageFromUrl } = await loadUploadMocks();
    mockFetch.mockResolvedValue({
      response: {
        ok: false,
        status: 404
      },
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(void 0)
    });
    const result = await uploadImageFromUrl("https://example.com/image.png");
    expect(result).toBe("https://example.com/image.png");
  });
  it("returns original URL if upload fails", async () => {
    const { mockUploadFile, uploadImageFromUrl } = await setupSuccessfulUpload();
    mockUploadFile.mockRejectedValue(new Error("Upload failed"));
    const result = await uploadImageFromUrl("https://example.com/image.png");
    expect(result).toBe("https://example.com/image.png");
  });
  it("rejects non-http(s) URLs", async () => {
    const { uploadImageFromUrl } = await import("./upload.js");
    const result = await uploadImageFromUrl("file:///etc/passwd");
    expect(result).toBe("file:///etc/passwd");
    const result2 = await uploadImageFromUrl("ftp://example.com/image.png");
    expect(result2).toBe("ftp://example.com/image.png");
  });
  it("handles invalid URLs gracefully", async () => {
    const { uploadImageFromUrl } = await import("./upload.js");
    const result = await uploadImageFromUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url");
  });
  it("extracts filename from URL path", async () => {
    const { mockFetch, mockUploadFile, uploadImageFromUrl } = await loadUploadMocks();
    const mockBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/path/to/my-image.jpg",
      contentType: "image/jpeg"
    });
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.jpg" });
    await uploadImageFromUrl("https://example.com/path/to/my-image.jpg");
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "my-image.jpg"
      })
    );
  });
  it("uses default filename when URL has no path", async () => {
    const { mockFetch, mockUploadFile, uploadImageFromUrl } = await loadUploadMocks();
    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/",
      contentType: "image/png"
    });
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });
    await uploadImageFromUrl("https://example.com/");
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.stringMatching(/^upload-\d+\.png$/)
      })
    );
  });
});
