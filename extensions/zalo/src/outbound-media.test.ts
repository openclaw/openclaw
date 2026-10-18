import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createMockServerResponse,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

import {
  prepareHostedZaloMediaUrl,
  resolveHostedZaloMediaRoutePrefix,
  tryHandleHostedZaloMediaRequest,
} from "./outbound-media.js";
import { setZaloRuntime } from "./runtime.js";

const testStateDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  });
});
const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: testStateDirs.make("openclaw-zalo-media-", resolvePreferredOpenClawTmpDir()),
};

function installZaloRuntimeForTest(env = testStateEnv): void {
  setZaloRuntime({
    state: {
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("zalo", { ...options, env }),
    },
  } as unknown as PluginRuntime);
}

function prepareMedia(overrides: Partial<Parameters<typeof prepareHostedZaloMediaUrl>[0]> = {}) {
  return prepareHostedZaloMediaUrl({
    mediaUrl: "https://example.com/photo.png",
    webhookUrl: "https://gateway.example.com/zalo-webhook",
    maxBytes: 1024,
    ...overrides,
  });
}

async function requestMedia(url: string | URL, method = "GET", statusCode: 200 | 401 | 404 = 200) {
  const { pathname, search } = new URL(url, "https://gateway.example.com");
  const res = createMockServerResponse();
  const end = vi.spyOn(res, "end");
  const handled = await tryHandleHostedZaloMediaRequest(
    { method, url: `${pathname}${search}` } as never,
    res,
  );
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(statusCode);
  const body = {
    200: method === "HEAD" ? undefined : Buffer.from("image-bytes"),
    401: "Unauthorized",
    404: "Not Found",
  }[statusCode];
  expect(end).toHaveBeenCalledWith(body);
  return res;
}

describe("zalo outbound hosted media", () => {
  beforeEach(async () => {
    installZaloRuntimeForTest();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  it("passes proxy-aware fetch options into hosted media downloads", async () => {
    const hostedUrl = await prepareMedia({ proxyUrl: "http://proxy.example:8080" });
    expect(hostedUrl).toMatch(
      /^https:\/\/gateway\.example\.com\/zalo-webhook\/media\/[a-f0-9]+\?token=[a-f0-9]+$/,
    );

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({ maxBytes: 1024, proxyUrl: "http://proxy.example:8080" }),
    );
  });

  it("preserves the root webhook path when deriving the hosted media route", () => {
    expect(resolveHostedZaloMediaRoutePrefix({ webhookUrl: "https://gateway.example.com/" })).toBe(
      "/media",
    );
  });

  it("serves HEAD metadata without consuming the hosted media", async () => {
    const hostedUrl = await prepareMedia();
    const headResponse = await requestMedia(hostedUrl, "HEAD");
    expect(headResponse.getHeader("Content-Length")).toBe(String(Buffer.byteLength("image-bytes")));

    const getResponse = await requestMedia(hostedUrl);
    expect(getResponse.getHeader("Content-Type")).toBe("image/png");
    await requestMedia(hostedUrl, "GET", 404);
  });

  it("uses the current runtime's state after runtime replacement", async () => {
    const hostedUrl = new URL(await prepareMedia());
    const replacementStateDir = testStateDirs.make(
      "openclaw-zalo-media-replacement-",
      resolvePreferredOpenClawTmpDir(),
    );
    try {
      installZaloRuntimeForTest({ ...testStateEnv, OPENCLAW_STATE_DIR: replacementStateDir });
      await requestMedia(hostedUrl, "HEAD", 404);

      installZaloRuntimeForTest();
      await requestMedia(hostedUrl);
    } finally {
      installZaloRuntimeForTest();
    }
  });

  it("rejects hosted media preparation when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      await expect(prepareMedia()).rejects.toThrow(/expiry/);

      expect(loadWebMediaMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = await prepareMedia({
      webhookUrl: "https://gateway.example.com/custom/zalo",
      webhookPath: "/custom/zalo-hook",
    });
    const pathname = new URL(hostedUrl).pathname;
    await requestMedia(`${pathname}?token=wrong`, "GET", 401);
  });

  it("rejects malformed hosted media ids before touching disk", async () => {
    await requestMedia("/zalo-webhook/media/not-a-valid-hex-id?token=wrong", "GET", 404);
  });
});
