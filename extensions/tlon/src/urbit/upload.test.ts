import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

// Mock urbitFetch
vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

// Mock @tloncorp/api
vi.mock("@tloncorp/api", () => ({
  uploadFile: vi.fn(),
}));

describe("uploadImageFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches image and calls uploadFile, returns uploaded URL", async () => {
    const { urbitFetch } = await import("./fetch.js");
    const mockUrbitFetch = vi.mocked(urbitFetch);

    const { uploadFile } = await import("@tloncorp/api");
    const mockUploadFile = vi.mocked(uploadFile);

    // Mock urbitFetch to return a successful response with a blob
    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockUrbitFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => Promise.resolve(mockBlob),
      } as unknown as Response,
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(undefined),
    });

    // Mock uploadFile to return a successful upload
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });

    const { uploadImageFromUrl } = await import("./upload.js");
    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://memex.tlon.network/uploaded.png");
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        blob: mockBlob,
        contentType: "image/png",
      }),
    );
  });

  it("returns original URL if fetch fails", async () => {
    const { urbitFetch } = await import("./fetch.js");
    const mockUrbitFetch = vi.mocked(urbitFetch);

    // Mock urbitFetch to return a failed response
    mockUrbitFetch.mockResolvedValue({
      response: {
        ok: false,
        status: 404,
      } as unknown as Response,
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(undefined),
    });

    const { uploadImageFromUrl } = await import("./upload.js");
    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
  });

  it("returns original URL if upload fails", async () => {
    const { urbitFetch } = await import("./fetch.js");
    const mockUrbitFetch = vi.mocked(urbitFetch);

    const { uploadFile } = await import("@tloncorp/api");
    const mockUploadFile = vi.mocked(uploadFile);

    // Mock urbitFetch to return a successful response
    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockUrbitFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => Promise.resolve(mockBlob),
      } as unknown as Response,
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(undefined),
    });

    // Mock uploadFile to throw an error
    mockUploadFile.mockRejectedValue(new Error("Upload failed"));

    const { uploadImageFromUrl } = await import("./upload.js");
    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
  });

  it("rejects non-http(s) URLs", async () => {
    const { uploadImageFromUrl } = await import("./upload.js");

    // file:// URL should be rejected
    const result = await uploadImageFromUrl("file:///etc/passwd");
    expect(result).toBe("file:///etc/passwd");

    // ftp:// URL should be rejected
    const result2 = await uploadImageFromUrl("ftp://example.com/image.png");
    expect(result2).toBe("ftp://example.com/image.png");
  });

  it("handles invalid URLs gracefully", async () => {
    const { uploadImageFromUrl } = await import("./upload.js");

    // Invalid URL should return original
    const result = await uploadImageFromUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url");
  });

  it("extracts filename from URL path", async () => {
    const { urbitFetch } = await import("./fetch.js");
    const mockUrbitFetch = vi.mocked(urbitFetch);

    const { uploadFile } = await import("@tloncorp/api");
    const mockUploadFile = vi.mocked(uploadFile);

    const mockBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    mockUrbitFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        blob: () => Promise.resolve(mockBlob),
      } as unknown as Response,
      finalUrl: "https://example.com/path/to/my-image.jpg",
      release: vi.fn().mockResolvedValue(undefined),
    });

    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.jpg" });

    const { uploadImageFromUrl } = await import("./upload.js");
    await uploadImageFromUrl("https://example.com/path/to/my-image.jpg");

    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "my-image.jpg",
      }),
    );
  });

  it("uses default filename when URL has no path", async () => {
    const { urbitFetch } = await import("./fetch.js");
    const mockUrbitFetch = vi.mocked(urbitFetch);

    const { uploadFile } = await import("@tloncorp/api");
    const mockUploadFile = vi.mocked(uploadFile);

    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockUrbitFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => Promise.resolve(mockBlob),
      } as unknown as Response,
      finalUrl: "https://example.com/",
      release: vi.fn().mockResolvedValue(undefined),
    });

    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });

    const { uploadImageFromUrl } = await import("./upload.js");
    await uploadImageFromUrl("https://example.com/");

    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.stringMatching(/^upload-\d+\.png$/),
      }),
    );
  });
});
