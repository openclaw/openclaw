import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";

const { mockFetchGuard, mockRelease, mockGetSignedUrl } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
  mockGetSignedUrl: vi.fn(),
}));

vi.mock(import("openclaw/plugin-sdk/ssrf-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWithSsrFGuard: mockFetchGuard,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mockGetSignedUrl }));
// mock-isolation: upload tests supply authentication without contacting a ship.
vi.mock("./urbit/auth.js", () => ({ authenticate: vi.fn() }));
// mock-isolation: upload tests supply storage scries without a live channel transport.
vi.mock("./urbit/channel-ops.js", () => ({ scryUrbitPath: vi.fn() }));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { type ClientConfig, uploadFile } from "./tlon-api.js";

const mockAuthenticate = vi.mocked(authenticate);
const mockScryUrbitPath = vi.mocked(scryUrbitPath);
const mockGuardedFetch = vi.mocked(fetchWithSsrFGuard);

const MEMEX_ENDPOINT = "https://memex.tlon.network/v1/zod/upload";
const MEMEX_UPLOAD_URL = "https://uploads.tlon.network/put";
const S3_UPLOAD_URL = "https://s3.example.com/uploads/file?sig=abc";
const MEMEX_FILE = "https://memex.tlon.network/files/uploaded.png";
const AVATAR_UPLOAD = {
  blob: new Blob(["image-bytes"], { type: "image/png" }),
  fileName: "avatar.png",
  contentType: "image/png",
};

const MEMEX_STORAGE = {
  configuration: { currentBucket: "uploads", service: "presigned-url" },
  secret: "genuine-secret",
};

const CUSTOM_STORAGE = {
  configuration: {
    currentBucket: "uploads",
    publicUrlBase: "https://files.example.com/",
    region: "us-east-1",
    service: "custom",
  },
  credentials: {
    endpoint: "https://s3.example.com",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "fake-secret",
  },
};

let testClientConfig: ClientConfig;

const responseWithCancelableBody = (
  status: number,
  cancelBody: () => void | PromiseLike<void>,
): Response => new Response(new ReadableStream<Uint8Array>({ cancel: cancelBody }), { status });

function configureTestClient(shipUrl: string, dangerouslyAllowPrivateNetwork?: boolean): void {
  testClientConfig = {
    shipUrl,
    shipName: "~zod",
    getCode: async () => "123456",
    dangerouslyAllowPrivateNetwork,
  };
}

function mockStorageScry(params: {
  configuration: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  secret?: string;
}): void {
  mockScryUrbitPath.mockImplementation(async (_deps, { path }) => {
    const value =
      path === "/storage/configuration.json"
        ? params.configuration
        : path === "/storage/credentials.json"
          ? { "storage-update": params.credentials ? { credentials: params.credentials } : {} }
          : path === "/genuine/secret.json" && params.secret
            ? { secret: params.secret }
            : undefined;
    return expectDefined(value, `Unexpected scry path: ${path}`);
  });
}

function mockMemexLookup(url = MEMEX_UPLOAD_URL, filePath = MEMEX_FILE): void {
  mockGuardedResponse(MEMEX_ENDPOINT, Response.json({ url, filePath }));
}

function mockGuardedResponse(
  finalUrl: string,
  response = new Response(null, { status: 200 }),
  release: () => Promise<void> = mockRelease,
): void {
  mockGuardedFetch.mockResolvedValueOnce({ response, finalUrl, release });
}

const uploadAvatar = (clientConfig: ClientConfig = testClientConfig) =>
  uploadFile(AVATAR_UPLOAD, clientConfig);

function expectGuardCleanup(fetches: number, releases = fetches) {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mockGuardedFetch).toHaveBeenCalledTimes(fetches);
  expect(mockRelease).toHaveBeenCalledTimes(releases);
}

function expectGuardRequest(index: number, url: string, auditContext: string, timeoutMs = 300_000) {
  const call = mockGuardedFetch.mock.calls[index]?.[0];
  expect(call).toMatchObject({ url, auditContext, capture: false, maxRedirects: 0, timeoutMs });
  expect(call?.init?.method).toBe("PUT");
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
  configureTestClient("https://groups.tlon.network");
  mockStorageScry(MEMEX_STORAGE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadFile memex upload hardening", () => {
  it("routes scheme-less hosted ships through the Memex SSRF guard", async () => {
    configureTestClient("foo.tlon.network", true);
    const lookupResponse = Response.json({
      url: "https://uploads.tlon.network:443/put",
      filePath: MEMEX_FILE,
    });
    const lookupCancel = vi.spyOn(lookupResponse.body!, "cancel");
    const uploadCancel = vi.fn();
    mockGuardedResponse(MEMEX_ENDPOINT, lookupResponse);
    mockGuardedResponse(MEMEX_UPLOAD_URL, responseWithCancelableBody(200, uploadCancel));

    await expect(uploadAvatar()).resolves.toEqual({ url: MEMEX_FILE });
    expectGuardCleanup(2);
    const firstCall = expectGuardRequest(0, MEMEX_ENDPOINT, "tlon-memex-upload-url", 30_000);
    expect(firstCall?.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(firstCall?.init?.body as string)).toMatchObject({
      token: "genuine-secret",
      contentLength: 11,
      contentType: "image/png",
      fileName: expect.any(String),
    });
    const secondCall = expectGuardRequest(1, MEMEX_UPLOAD_URL, "tlon-memex-upload", 300_000);
    expect(secondCall?.init?.headers).toEqual({
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/png",
    });
    expect(secondCall?.policy).toBeUndefined();
    expect(secondCall?.init?.body).toBeInstanceOf(Blob);
    expect(lookupCancel).not.toHaveBeenCalled();
    expect(uploadCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels failed Memex upload URL responses before releasing their guard", async () => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    mockGuardedResponse(MEMEX_ENDPOINT, responseWithCancelableBody(500, cancelBody), release);

    await expect(uploadAvatar()).rejects.toThrow("Memex upload request failed: 500");

    expect(events).toEqual(["cancel", "release"]);
  });

  it("surfaces guarded upload failures for hosted Memex targets", async () => {
    mockMemexLookup();
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked upload target"));

    await expect(uploadAvatar()).rejects.toThrow("Blocked upload target");

    expectGuardCleanup(2, 1);
    expectGuardRequest(1, MEMEX_UPLOAD_URL, "tlon-memex-upload");
  });

  const untrusted = "must target a trusted hosted Tlon domain";
  it.each([
    ["upload", MEMEX_UPLOAD_URL, "Upload failed: 500"],
    ["final upload", "https://evil.example/put", untrusted],
    ["target", "https://eviltlon.network/upload", untrusted],
    ["target", "https://uploads.tlon.network:8443/put", "must not specify a non-standard port"],
    ["hosted", "https://evil.example/files/uploaded.png", untrusted],
  ])("rejects Memex %s URL %s", async (stage, url, reason) => {
    const isUpload = stage === "upload" || stage === "final upload";
    const cancelBody = vi.fn();
    mockMemexLookup(
      stage === "target" ? url : MEMEX_UPLOAD_URL,
      stage === "hosted" ? url : undefined,
    );
    if (stage !== "target") {
      mockGuardedResponse(
        isUpload ? url : MEMEX_UPLOAD_URL,
        isUpload ? responseWithCancelableBody(500, cancelBody) : undefined,
      );
    }
    const error =
      stage === "upload" ? reason : `Memex ${stage === "target" ? "upload" : stage} URL ${reason}`;
    await expect(uploadAvatar()).rejects.toThrow(error);
    expectGuardCleanup(stage === "target" ? 1 : 2);
    if (isUpload) {
      expect(cancelBody).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects an oversized Memex upload JSON response", async () => {
    const cancelBody = vi.fn();
    let bodyReads = 0;
    mockGuardedResponse(
      MEMEX_ENDPOINT,
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            bodyReads += 1;
            controller.enqueue(new Uint8Array(32 * 1024).fill(120));
          },
          cancel: cancelBody,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(uploadAvatar()).rejects.toThrow("Memex upload: JSON response exceeds 65536 bytes");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(bodyReads).toBeLessThan(10);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects truly unparseable ship URLs as not hosted", async () => {
    configureTestClient("   ");
    mockStorageScry({ configuration: MEMEX_STORAGE.configuration });

    await expect(uploadAvatar()).rejects.toThrow("No storage credentials configured");
    expectGuardCleanup(0);
  });
});

describe("uploadFile custom S3 upload hardening", () => {
  beforeEach(() => {
    configureTestClient("https://ship.example.com");
    mockStorageScry(CUSTOM_STORAGE);
  });

  it("routes DigitalOcean S3 uploads through the guard with required headers", async () => {
    const url = "https://bucket.nyc3.digitaloceanspaces.com/file?sig=abc";
    const headers = {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/png",
      "x-amz-acl": "public-read",
    };
    const cancelBody = vi.fn(async () => {
      throw new Error("stream cancellation failed");
    });
    mockGetSignedUrl.mockResolvedValueOnce(url);
    mockGuardedResponse(url, responseWithCancelableBody(200, cancelBody));

    await expect(uploadAvatar()).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/files\.example\.com\//),
    });
    const signedUrlCall = expectDefined(mockGetSignedUrl.mock.calls[0], "S3 signed URL call");
    expect((await signedUrlCall[0].config.endpoint()).protocol).toBe("https:");
    expectGuardCleanup(1);
    const uploadCall = expectGuardRequest(0, url, "tlon-custom-s3-upload", 300_000);
    expect(uploadCall?.init?.headers).toEqual(headers);
    expect(uploadCall?.policy).toBeUndefined();
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("passes the private-network opt-in to guarded custom S3 uploads", async () => {
    configureTestClient("https://ship.example.com", true);
    const url = "https://10.0.0.15/uploads/file?sig=abc";
    mockGetSignedUrl.mockResolvedValueOnce(url);
    mockGuardedResponse(url);

    await expect(uploadAvatar()).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/files\.example\.com\//),
    });
    expectGuardCleanup(1);
    const uploadCall = expectGuardRequest(0, url, "tlon-custom-s3-upload");
    expect(uploadCall?.policy).toEqual({ allowPrivateNetwork: true });
  });

  it("rejects custom S3 result URLs that are not http(s)", async () => {
    mockStorageScry({
      ...CUSTOM_STORAGE,
      configuration: {
        ...CUSTOM_STORAGE.configuration,
        publicUrlBase: "ftp://files.example.com/",
      },
    });
    mockGetSignedUrl.mockResolvedValueOnce(S3_UPLOAD_URL);
    mockGuardedResponse(S3_UPLOAD_URL);

    await expect(uploadAvatar()).rejects.toThrow("Upload result URL must use http or https");

    expectGuardCleanup(1);
  });
});

describe("uploadFile send authority", () => {
  it("blocks the S3 upload when authority closes during signing", async () => {
    configureTestClient("https://ship.example.com");
    mockStorageScry(CUSTOM_STORAGE);
    const signingStarted = createDeferred<void>();
    const signedUrl = createDeferred<string>();
    const authorityError = new Error("Tlon send authority revoked");
    const authority = new AbortController();
    const assertDirectAdapterHandoff = () => authority.signal.throwIfAborted();
    mockGetSignedUrl.mockImplementationOnce(() => {
      signingStarted.resolve();
      return signedUrl.promise;
    });
    const dispatch = vi.fn();
    mockGuardedFetch.mockImplementationOnce(async (request) => {
      request.beforeRequest?.();
      dispatch();
      return {
        response: new Response(null, { status: 200 }),
        finalUrl: S3_UPLOAD_URL,
        release: mockRelease,
      };
    });

    const upload = uploadAvatar({ ...testClientConfig, assertDirectAdapterHandoff });
    const rejected = expect(upload).rejects.toBe(authorityError);
    await signingStarted.promise;
    authority.abort(authorityError);
    signedUrl.resolve(S3_UPLOAD_URL);
    await rejected;

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it.each(["memex", "custom S3"])(
    "retains an accepted %s upload when authority closes during its response",
    async (storage) => {
      const useMemex = storage === "memex";
      configureTestClient(useMemex ? "https://groups.tlon.network" : "https://ship.example.com");
      mockStorageScry(useMemex ? MEMEX_STORAGE : CUSTOM_STORAGE);
      const uploadUrl = useMemex ? MEMEX_UPLOAD_URL : S3_UPLOAD_URL;
      if (useMemex) {
        mockMemexLookup();
      } else {
        mockGetSignedUrl.mockResolvedValueOnce(uploadUrl);
      }
      const assertDirectAdapterHandoff = vi.fn();
      const cancelBody = vi.fn();
      mockGuardedFetch.mockImplementationOnce(async (request) => {
        request.beforeRequest?.();
        assertDirectAdapterHandoff.mockImplementation(() => {
          throw new Error("Tlon send authority revoked");
        });
        return {
          response: responseWithCancelableBody(200, cancelBody),
          finalUrl: uploadUrl,
          release: mockRelease,
        };
      });

      const result = await uploadAvatar({ ...testClientConfig, assertDirectAdapterHandoff });

      if (useMemex) {
        expect(result).toEqual({ url: MEMEX_FILE });
      } else {
        expect(result.url.startsWith("https://files.example.com/")).toBe(true);
      }
      expect(cancelBody).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledTimes(useMemex ? 2 : 1);
    },
  );
});
