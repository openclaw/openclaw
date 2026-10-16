import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
// Zalo tests cover outbound media plugin behavior.
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/web-media", () => {
  return {
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
  };
});

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

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

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
    expect(
      resolveHostedZaloMediaRoutePrefix({
        webhookUrl: "https://gateway.example.com/",
      }),
    ).toBe("/media");
  });

  it("serves HEAD metadata without consuming the hosted media", async () => {
    const hostedUrl = await prepareMedia();
    const { pathname, search } = new URL(hostedUrl);
    const headResponse = createMockResponse();

    const handledHead = await tryHandleHostedZaloMediaRequest(
      {
        method: "HEAD",
        url: `${pathname}${search}`,
      } as never,
      headResponse.res as never,
    );

    expect(handledHead).toBe(true);
    expect(headResponse.res.statusCode).toBe(200);
    expect(headResponse.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength("image-bytes")),
    );
    expect(headResponse.res.end).toHaveBeenCalledWith(undefined);

    const getResponse = createMockResponse();
    await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      getResponse.res as never,
    );
    expect(getResponse.res.statusCode).toBe(200);
    expect(getResponse.headers.get("Content-Type")).toBe("image/png");
    expect(getResponse.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));

    const consumedResponse = createMockResponse();
    await tryHandleHostedZaloMediaRequest(
      { method: "GET", url: `${pathname}${search}` } as never,
      consumedResponse.res as never,
    );
    expect(consumedResponse.res.statusCode).toBe(404);
  });

  it("uses the current runtime's state after runtime replacement", async () => {
    const hostedUrl = new URL(await prepareMedia());
    const replacementStateDir = testStateDirs.make(
      "openclaw-zalo-media-replacement-",
      resolvePreferredOpenClawTmpDir(),
    );
    try {
      installZaloRuntimeForTest({ ...testStateEnv, OPENCLAW_STATE_DIR: replacementStateDir });
      const response = createMockResponse();
      await tryHandleHostedZaloMediaRequest(
        { method: "HEAD", url: `${hostedUrl.pathname}${hostedUrl.search}` } as never,
        response.res as never,
      );
      expect(response.res.statusCode).toBe(404);
      expect(response.res.end).toHaveBeenCalledWith("Not Found");

      installZaloRuntimeForTest();
      const original = createMockResponse();
      await tryHandleHostedZaloMediaRequest(
        { method: "GET", url: `${hostedUrl.pathname}${hostedUrl.search}` } as never,
        original.res as never,
      );
      expect(original.res.statusCode).toBe(200);
      expect(original.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));
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
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}?token=wrong`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
  });

  it("rejects malformed hosted media ids before touching disk", async () => {
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: "/zalo-webhook/media/not-a-valid-hex-id?token=wrong",
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
  });
});
