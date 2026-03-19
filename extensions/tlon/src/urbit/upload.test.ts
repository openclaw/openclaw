import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

// Mock fetchWithSsrFGuard from the focused infra seam.
vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(),
  };
});

describe("uploadImageFromUrl", () => {
  async function loadUploadMocks() {
    const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/infra-runtime");
    const { uploadImageFromUrl } = await import("./upload.js");
    return {
      mockFetch: vi.mocked(fetchWithSsrFGuard),
      uploadImageFromUrl,
    };
  }

  type UploadMocks = Awaited<ReturnType<typeof loadUploadMocks>>;

  function mockSuccessfulFetch(params: {
    mockFetch: UploadMocks["mockFetch"];
    blob: Blob;
    finalUrl: string;
    contentType: string;
  }) {
    params.mockFetch.mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ "content-type": params.contentType }),
        blob: () => Promise.resolve(params.blob),
      } as unknown as Response,
      finalUrl: params.finalUrl,
      release: vi.fn().mockResolvedValue(undefined),
    });
  }

  async function setupSuccessfulUpload(params?: { sourceUrl?: string; contentType?: string }) {
    const { mockFetch, uploadImageFromUrl } = await loadUploadMocks();
    const sourceUrl = params?.sourceUrl ?? "https://example.com/image.png";
    const contentType = params?.contentType ?? "image/png";
    const mockBlob = new Blob(["fake-image"], { type: contentType });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: sourceUrl,
      contentType,
    });
    return { mockBlob, uploadImageFromUrl };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches image and returns the resolved URL", async () => {
    const { mockBlob, uploadImageFromUrl } = await setupSuccessfulUpload({
      sourceUrl: "https://memex.tlon.network/uploaded.png",
    });

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(mockBlob.size).toBeGreaterThan(0);
    expect(result).toBe("https://memex.tlon.network/uploaded.png");
  });

  it("returns original URL if fetch fails", async () => {
    const { mockFetch, uploadImageFromUrl } = await loadUploadMocks();

    mockFetch.mockResolvedValue({
      response: {
        ok: false,
        status: 404,
      } as unknown as Response,
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(undefined),
    });

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

  it("preserves a fetched image URL with a path", async () => {
    const { mockFetch, uploadImageFromUrl } = await loadUploadMocks();
    const mockBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/path/to/my-image.jpg",
      contentType: "image/jpeg",
    });

    const result = await uploadImageFromUrl("https://example.com/path/to/my-image.jpg");
    expect(result).toBe("https://example.com/path/to/my-image.jpg");
  });

  it("preserves a fetched image URL when the path is empty", async () => {
    const { mockFetch, uploadImageFromUrl } = await loadUploadMocks();
    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/",
      contentType: "image/png",
    });

    const result = await uploadImageFromUrl("https://example.com/");
    expect(result).toBe("https://example.com/");
  });
});
