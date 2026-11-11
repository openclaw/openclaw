import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ClientConfig, uploadFile } from "./tlon-api.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  release: vi.fn(async () => {}),
  sign: vi.fn<typeof import("@aws-sdk/s3-request-presigner").getSignedUrl>(),
  authenticate: vi.fn<typeof import("./urbit/auth.js").authenticate>(),
  scry: vi.fn<typeof import("./urbit/channel-ops.js").scryUrbitPath>(),
}));
vi.mock(import("openclaw/plugin-sdk/ssrf-runtime"), async (original) => ({
  ...(await original()),
  fetchWithSsrFGuard: mocks.fetch,
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.sign }));
// mock-isolation: supply ship authentication and storage without a live transport.
vi.mock("./urbit/auth.js", () => ({ authenticate: mocks.authenticate }));
// mock-isolation: Serve synthetic storage configuration instead of contacting a ship.
vi.mock("./urbit/channel-ops.js", () => ({ scryUrbitPath: mocks.scry }));

const ENDPOINT = "https://memex.tlon.network/v1/zod/upload";
const PUT = "https://uploads.tlon.network/put";
const FILE = "https://memex.tlon.network/files/uploaded.png";
const S3 = "https://s3.example.com/uploads/file?sig=abc";
const DO = "https://bucket.nyc3.digitaloceanspaces.com/file?sig=abc";
const HEADERS = { "Cache-Control": "public, max-age=3600", "Content-Type": "image/png" };
const IMAGE = {
  blob: new Blob(["image-bytes"], { type: "image/png" }),
  fileName: "avatar.png",
};
let config: ClientConfig;

function storage(custom = false, publicUrlBase = "https://files.example.com/") {
  config = {
    shipUrl: custom ? "https://ship.example.com" : "https://groups.tlon.network",
    shipName: "~zod",
    getCode: async () => "123456",
  };
  const credentials = {
    endpoint: "https://s3.example.com",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "fake-secret",
  };
  const responses: Record<string, unknown> = {
    "/storage/configuration.json": {
      currentBucket: "uploads",
      service: custom ? "custom" : "presigned-url",
      publicUrlBase,
      region: "us-east-1",
    },
    "/storage/credentials.json": {
      "storage-update": custom ? { credentials } : {},
    },
    "/genuine/secret.json": { secret: "genuine-secret" },
  };
  mocks.scry.mockImplementation(async (_deps, { path }) => expectDefined(responses[path], path));
}
const upload = () => uploadFile(IMAGE, config);
const bodyResponse = (status: number, cancel: () => void | PromiseLike<void>) =>
  new Response(new ReadableStream<Uint8Array>({ cancel }), { status });
function guarded(
  finalUrl: string,
  response = new Response(null, { status: 200 }),
  release = mocks.release,
  beforeResponse?: () => void,
) {
  mocks.fetch.mockImplementationOnce(async (options) => {
    options.beforeRequest?.();
    beforeResponse?.();
    return { response, finalUrl, release };
  });
  return response;
}
const lookup = (url = PUT, filePath = FILE) => guarded(ENDPOINT, Response.json({ url, filePath }));
function cleanup(count: number) {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(count);
  expect(mocks.release).toHaveBeenCalledTimes(count);
}
function request(index: number, url: string, timeoutMs = 300_000) {
  const call = mocks.fetch.mock.calls[index]?.[0];
  expect(call).toMatchObject({
    url,
    capture: false,
    maxRedirects: 0,
    timeoutMs,
    init: { method: "PUT" },
  });
  return call;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", vi.fn());
  mocks.authenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
  storage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("cancels failed Memex allocation responses before releasing their guard", async () => {
  const events: string[] = [];
  guarded(
    ENDPOINT,
    bodyResponse(500, () => {
      events.push("cancel");
    }),
    vi.fn(async () => {
      events.push("release");
    }),
  );
  await expect(upload()).rejects.toThrow("Memex upload request failed: 500");
  expect(events).toEqual(["cancel", "release"]);
});

const untrusted = "must target a trusted hosted Tlon domain";
it.each([
  ["upload", PUT, "Upload failed: 500"],
  ["final upload", "https://evil.example/put", untrusted],
  ["target", "https://eviltlon.network/upload", untrusted],
  ["target", "https://uploads.tlon.network:8443/put", "must not specify a non-standard port"],
  ["hosted", "https://evil.example/files/uploaded.png", untrusted],
])("rejects Memex %s URL %s", async (stage, url, reason) => {
  const isUpload = stage === "upload" || stage === "final upload";
  const cancel = vi.fn();
  lookup(stage === "target" ? url : PUT, stage === "hosted" ? url : undefined);
  if (stage !== "target") {
    guarded(isUpload ? url : PUT, isUpload ? bodyResponse(500, cancel) : undefined);
  }
  await expect(upload()).rejects.toThrow(
    stage === "upload" ? reason : `Memex ${stage === "target" ? "upload" : stage} URL ${reason}`,
  );
  cleanup(stage === "target" ? 1 : 2);
  if (isUpload) {
    expect(cancel).toHaveBeenCalledTimes(1);
  }
});

it("bounds and cancels oversized Memex allocation responses", async () => {
  const cancel = vi.fn();
  let reads = 0;
  guarded(
    ENDPOINT,
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(32 * 1024).fill(120));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await expect(upload()).rejects.toThrow("Memex upload: JSON response exceeds 65536 bytes");
  expect(reads).toBeLessThan(10);
  expect(cancel).toHaveBeenCalledTimes(1);
  cleanup(1);
});

it("rejects unparseable ship URLs without storage credentials", async () => {
  config.shipUrl = "   ";
  await expect(upload()).rejects.toThrow("No storage credentials configured");
  cleanup(0);
});

it("passes the private-network opt-in to guarded custom S3 uploads", async () => {
  storage(true);
  config.dangerouslyAllowPrivateNetwork = true;
  const url = "https://10.0.0.15/uploads/file?sig=abc";
  mocks.sign.mockResolvedValueOnce(url);
  guarded(url);
  await expect(upload()).resolves.toMatchObject({
    url: expect.stringMatching(/^https:\/\/files\.example\.com\//),
  });
  cleanup(1);
  expect(request(0, url)?.policy).toEqual({ allowPrivateNetwork: true });
});

it("rejects custom S3 result URLs that are not http(s)", async () => {
  storage(true, "ftp://files.example.com/");
  mocks.sign.mockResolvedValueOnce(S3);
  guarded(S3);
  await expect(upload()).rejects.toThrow("Upload result URL must use http or https");
  cleanup(1);
});

it("blocks the S3 upload when authority closes during signing", async () => {
  storage(true);
  const started = createDeferred<void>();
  const signed = createDeferred<string>();
  const revoked = new Error("Tlon send authority revoked");
  const authority = new AbortController();
  config.assertDirectAdapterHandoff = () => authority.signal.throwIfAborted();
  mocks.sign.mockImplementationOnce(() => {
    started.resolve();
    return signed.promise;
  });
  const dispatch = vi.fn();
  guarded(S3, undefined, mocks.release, dispatch);
  const rejected = expect(upload()).rejects.toBe(revoked);
  await started.promise;
  authority.abort(revoked);
  signed.resolve(S3);
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
  expect(mocks.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains an accepted upload after authority closes (custom S3=%s)",
  async (custom) => {
    storage(custom);
    config.shipUrl = custom ? config.shipUrl : "foo.tlon.network";
    config.dangerouslyAllowPrivateNetwork = !custom;
    const url = custom ? DO : PUT;
    const lookupCancel = custom
      ? undefined
      : vi.spyOn(lookup("https://uploads.tlon.network:443/put").body!, "cancel");
    if (custom) {
      mocks.sign.mockResolvedValueOnce(url);
    }
    const check = vi.fn();
    config.assertDirectAdapterHandoff = check;
    const cancel = vi.fn(async () => {
      if (custom) {
        throw new Error("stream cancellation failed");
      }
    });
    guarded(url, bodyResponse(200, cancel), mocks.release, () =>
      check.mockImplementation(() => {
        throw new Error("Tlon send authority revoked");
      }),
    );
    await expect(upload()).resolves.toEqual({
      url: custom ? expect.stringMatching(/^https:\/\/files\.example\.com\//) : FILE,
    });
    if (!custom) {
      expect(request(0, ENDPOINT, 30_000)?.init?.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(lookupCancel).not.toHaveBeenCalled();
    }
    const put = request(custom ? 0 : 1, url);
    expect(put?.init?.headers).toEqual(
      custom ? { ...HEADERS, "x-amz-acl": "public-read" } : HEADERS,
    );
    expect(put?.policy).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    cleanup(custom ? 1 : 2);
  },
);
