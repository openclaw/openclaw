import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";

const { mockFetchGuard, mockRelease, mockGetSignedUrl } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
  mockGetSignedUrl: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    fetchWithSsrFGuard: mockFetchGuard,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(),
}));

vi.mock("./urbit/channel-ops.js", () => ({
  scryUrbitPath: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { configureClient, uploadFile } from "./tlon-api.js";

const mockAuthenticate = vi.mocked(authenticate);
const mockScryUrbitPath = vi.mocked(scryUrbitPath);
const mockGuardedFetch = vi.mocked(fetchWithSsrFGuard);

function createMemexResponse(uploadUrl: string): Response {
  return new Response(
    JSON.stringify({
      url: uploadUrl,
      filePath: "https://memex.tlon.network/files/uploaded.png",
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("uploadFile memex upload hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
    configureClient({
      shipUrl: "https://groups.tlon.network",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.tlon.network/",
          presignedUrl: "https://files.tlon.network/presigned",
          region: "us-east-1",
          service: "presigned-url",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return { "storage-update": {} };
      }
      if (params.path === "/genuine/secret.json") {
        return { secret: "genuine-secret" };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes the memex upload URL through the SSRF guard", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createMemexResponse("https://uploads.tlon.network/put"));
    mockGuardedFetch.mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://uploads.tlon.network/put",
      release: mockRelease,
    });

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://memex.tlon.network/v1/zod/upload",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(mockGuardedFetch).toHaveBeenCalledWith({
      url: "https://uploads.tlon.network/put",
      init: expect.objectContaining({
        method: "PUT",
        body: expect.any(Blob),
        headers: expect.objectContaining({
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "image/png",
        }),
      }),
      auditContext: "tlon-memex-upload",
      capture: false,
      maxRedirects: 0,
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("surfaces guarded upload failures for hosted Memex targets", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createMemexResponse("https://uploads.tlon.network/put"));
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked upload target"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Blocked upload target");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGuardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.tlon.network/put",
        auditContext: "tlon-memex-upload",
        capture: false,
        maxRedirects: 0,
      }),
    );
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("rejects Memex upload targets outside the hosted Tlon domain allowlist", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createMemexResponse("https://eviltlon.network/upload"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Memex upload URL must target a trusted hosted Tlon domain");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("rejects Memex upload targets with a non-standard port", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createMemexResponse("https://uploads.tlon.network:8443/put"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Memex upload URL must not specify a non-standard port");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("disables redirects for Memex upload targets", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(createMemexResponse("https://uploads.tlon.network/put"));
    mockGuardedFetch.mockRejectedValueOnce(new Error("Too many redirects (limit: 0)"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Too many redirects (limit: 0)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockGuardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.tlon.network/put",
        auditContext: "tlon-memex-upload",
        capture: false,
        maxRedirects: 0,
      }),
    );
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("treats unparseable ship URLs as not hosted instead of falling back to a raw-string suffix match", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    configureClient({
      shipUrl: "foo.tlon.network",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.tlon.network/",
          presignedUrl: "https://files.tlon.network/presigned",
          region: "us-east-1",
          service: "presigned-url",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return { "storage-update": {} };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("No storage credentials configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("uploadFile custom S3 upload hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
    configureClient({
      shipUrl: "https://ship.example.com",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.example.com/",
          presignedUrl: "",
          region: "us-east-1",
          service: "custom",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return {
          "storage-update": {
            credentials: {
              endpoint: "https://s3.example.com",
              accessKeyId: "AKIAFAKE",
              secretAccessKey: "fake-secret",
            },
          },
        };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes the custom S3 signed URL through the SSRF guard", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://s3.example.com/uploads/file?sig=abc");
    mockGuardedFetch.mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://s3.example.com/uploads/file?sig=abc",
      release: mockRelease,
    });

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result.url.startsWith("https://files.example.com/")).toBe(true);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockGuardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://s3.example.com/uploads/file?sig=abc",
        auditContext: "tlon-custom-s3-upload",
        capture: false,
        maxRedirects: 0,
      }),
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("surfaces guarded upload failures for custom S3 targets without calling release", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://169.254.169.254/uploads/file?sig=abc");
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked private network target"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Blocked private network target");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
