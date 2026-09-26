// Vydra tests cover shared URL extraction and download behavior.
import { once } from "node:events";
import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadVydraAsset, extractVydraResultUrls } from "./shared.js";

describe("downloadVydraAsset", () => {
  installPinnedHostnameTestHooks();

  let server: http.Server | undefined;
  const dripTimers = new Set<ReturnType<typeof setTimeout>>();

  const requestPolicyFor = (url: string, allowPrivateNetwork = false) => ({
    allowPrivateNetwork,
    headers: new Headers(),
    headerOrigin: new URL(url).origin,
  });

  afterEach(async () => {
    for (const timer of dripTimers) {
      clearTimeout(timer);
    }
    dripTimers.clear();
    vi.useRealTimers();
    if (!server) {
      return;
    }
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
    server = undefined;
  });

  async function listenDripServer(params: {
    statusCode: number;
    contentType: string;
    chunk: Buffer | string;
  }): Promise<number> {
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(params.statusCode, {
        "Content-Type": params.contentType,
        "Transfer-Encoding": "chunked",
      });
      // Keep sending bytes so chunk idle alone would never fire.
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(params.chunk);
        const timer = setTimeout(drip, 20);
        dripTimers.add(timer);
      };
      drip();
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  async function expectDrippingDownloadTimeout(statusCode: number, wallClockTrailsTimer = false) {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const timeoutMs = 250;
    const port = await listenDripServer({
      statusCode,
      contentType: statusCode === 200 ? "image/png" : "text/plain",
      chunk: statusCode === 200 ? Buffer.from([0x00]) : "e",
    });
    const wallClock = Date.now();
    const dateNow = wallClockTrailsTimer
      ? vi.spyOn(Date, "now").mockReturnValue(wallClock)
      : undefined;
    const headersReceived = createDeferred<void>();
    const startedAt = performance.now();
    let settled = false;
    try {
      const download = downloadVydraAsset({
        url: `http://127.0.0.1:${port}/generated/test.png`,
        kind: "image",
        timeoutMs,
        fetchFn: async (input, init) => {
          const response = await fetchWithRuntimeDispatcher(input, init);
          headersReceived.resolve();
          return response;
        },
        maxBytes: 1024 * 1024,
        requestPolicy: requestPolicyFor(`http://127.0.0.1:${port}`, true),
      });
      void download.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Connection setup must finish before advancing the body deadline.
      await Promise.race([
        headersReceived.promise,
        download.then(() => {
          throw new Error("Dripping download completed before headers were received");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(download).rejects.toThrow(`Vydra image download timed out after ${timeoutMs}ms`);
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
      expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
      if (wallClockTrailsTimer) {
        expect(Date.now()).toBe(wallClock);
      }
    } finally {
      dateNow?.mockRestore();
    }
  }

  it("bounds a dripping download body with one wall-clock deadline", async () => {
    await expectDrippingDownloadTimeout(200);
  });

  it("bounds a dripping non-2xx error body with one wall-clock deadline", async () => {
    await expectDrippingDownloadTimeout(500);
  });

  it.each([200, 500])(
    "preserves the request timeout when wall-clock time trails its timer (HTTP %i)",
    async (statusCode) => {
      // The request timer can fire before Date reaches the absolute deadline.
      await expectDrippingDownloadTimeout(statusCode, true);
    },
  );

  // Completed-response semantics must not race host time; real drip tests above own deadlines.
  it("preserves normalized and redacted provider errors after the bounded read", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () =>
        new Response(
          JSON.stringify({ message: "Authorization: Bearer test-token", code: "asset_failed" }),
          {
            status: 502,
            headers: { "x-request-id": "req-vydra-test" },
          },
        ),
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
    }).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);

    expect(result).toMatchObject({
      name: "ProviderHttpError",
      status: 502,
      statusCode: 502,
      errorCode: "asset_failed",
      requestId: "req-vydra-test",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : "").not.toContain("test-token");
  });

  it("normalizes null-body HTTP errors after the bounded read", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () => new Response(null, { status: 304 }),
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
    }).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);

    expect(result).toMatchObject({ name: "ProviderHttpError", status: 304, statusCode: 304 });
  });

  it("preserves HTTP metadata when the error body stream fails", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("broken error body"));
            },
          }),
          {
            status: 502,
            headers: { "x-request-id": "req-vydra-broken-body" },
          },
        ),
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
    }).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);

    expect(result).toMatchObject({
      name: "ProviderHttpError",
      status: 502,
      statusCode: 502,
      requestId: "req-vydra-broken-body",
    });
  });

  it("preserves successful response body errors before the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.png",
      kind: "image",
      timeoutMs: 250,
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("broken success body"));
            },
          }),
          { status: 200 },
        ),
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
    }).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message: "broken success body" });
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as a downloaded video", async ({ contentType, body }) => {
    await expect(
      downloadVydraAsset({
        url: "https://cdn.vydra.example/generated/test.mp4",
        kind: "video",
        timeoutMs: 250,
        fetchFn: async () =>
          new Response(body, { status: 200, headers: { "content-type": contentType } }),
        maxBytes: 1024 * 1024,
        requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
      }),
    ).rejects.toThrow("Vydra video download: malformed video response");
  });

  it("keeps valid downloads alive beyond the binary reader's default idle timeout", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
      { headers: { "content-type": "video/mp4" } },
    );
    const result = downloadVydraAsset({
      url: "https://cdn.vydra.example/generated/test.mp4",
      kind: "video",
      timeoutMs: 45_000,
      fetchFn: async () => response,
      maxBytes: 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
  });

  it("labels malformed download rejections with the requested media kind", async () => {
    await expect(
      downloadVydraAsset({
        url: "https://cdn.vydra.example/generated/test.png",
        kind: "image",
        timeoutMs: 250,
        fetchFn: async () =>
          new Response('{"error":"denied"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        maxBytes: 1024 * 1024,
        requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
      }),
    ).rejects.toThrow("Vydra image download: malformed image response");
  });
});

it("preserves URL priority, traversal bounds and independent result arrays", () => {
  const payload = {
    audioUrl: "https://cdn.example/other.mp3",
    videoUrl: "https://cdn.example/other.mp4",
    imageUrls: ["https://cdn.example/second.png", [" https://cdn.example/first.png "]],
    imageUrl: " \thttps://cdn.example/first.png\n",
    url: "https://cdn.example/shared.png",
    resultUrl: "https://cdn.example/result.png",
    outputs: [
      { imageUrl: "https://cdn.example/second.png", url: "https://cdn.example/nested.png" },
      [[{ imageUrl: "https://cdn.example/array.png" }]],
    ],
    data: {
      data: {
        data: {
          data: {
            data: {
              imageUrl: "https://cdn.example/edge.png",
              data: { imageUrl: "https://cdn.example/too-deep.png" },
            },
          },
        },
      },
    },
  };
  const expected = [
    "https://cdn.example/first.png",
    "https://cdn.example/second.png",
    "https://cdn.example/result.png",
    "https://cdn.example/shared.png",
    "https://cdn.example/nested.png",
    "https://cdn.example/array.png",
    "https://cdn.example/edge.png",
  ];

  const urls = extractVydraResultUrls(payload, "image");
  expect(urls).toEqual(expected);
  urls.push("https://cdn.example/caller-owned.png");
  expect(extractVydraResultUrls(payload, "image")).toEqual(expected);
});
