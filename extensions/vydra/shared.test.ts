import { once } from "node:events";
import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadVydraAsset, extractVydraResultUrls } from "./shared.js";

type DownloadOptions = Parameters<typeof downloadVydraAsset>[0];

describe("downloadVydraAsset", () => {
  installPinnedHostnameTestHooks();

  let server: http.Server | undefined;
  let dripTimer: ReturnType<typeof setTimeout> | undefined;

  const requestPolicyFor = (url: string, allowPrivateNetwork = false) => ({
    allowPrivateNetwork,
    headers: new Headers(),
    headerOrigin: new URL(url).origin,
  });
  const download = (fetchFn: typeof fetch, overrides: Partial<DownloadOptions> = {}) =>
    downloadVydraAsset({
      url: `https://cdn.vydra.example/generated/test.${overrides.kind === "video" ? "mp4" : "png"}`,
      kind: "image",
      timeoutMs: 250,
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
      fetchFn,
      ...overrides,
    });
  function respond(body: BodyInit, init?: ResponseInit): typeof fetch {
    return async () => new Response(body, init);
  }

  afterEach(async () => {
    clearTimeout(dripTimer);
    dripTimer = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (!server) {
      return;
    }
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
    server = undefined;
  });

  async function listenDripServer(statusCode: number): Promise<number> {
    const chunk = statusCode === 200 ? Buffer.from([0x00]) : "e";
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(statusCode, {
        "Content-Type": statusCode === 200 ? "image/png" : "text/plain",
      });
      // One pending drip per response keeps the chunk-idle timeout from firing.
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(chunk);
        dripTimer = setTimeout(drip, 20);
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

  it.each([200, 500])("times out dripping HTTP %i with a frozen clock", async (statusCode) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const timeoutMs = 250;
    const port = await listenDripServer(statusCode);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const headersReceived = createDeferred<void>();
    const settled = vi.fn();
    const result = download(
      async (input, init) => {
        const response = await fetchWithRuntimeDispatcher(input, init);
        headersReceived.resolve();
        return response;
      },
      {
        url: `http://127.0.0.1:${port}/generated/test.png`,
        timeoutMs,
        requestPolicy: requestPolicyFor(`http://127.0.0.1:${port}`, true),
      },
    );
    void result.then(settled, settled);
    // Connection setup must finish before advancing the body deadline.
    await Promise.race([
      headersReceived.promise,
      result.then(() => {
        throw new Error("Dripping download completed before headers were received");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow(`Vydra image download timed out after ${timeoutMs}ms`);
  });

  it.each([502, 200])("preserves body failures and clears timers (HTTP %i)", async (status) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await download(
      respond(
        new ReadableStream({
          start: (controller) => controller.error(new Error("broken body")),
        }),
        {
          status,
          ...(status === 502 ? { headers: { "x-request-id": "req-vydra-broken-body" } } : {}),
        },
      ),
    ).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject(
      status === 502
        ? {
            name: "ProviderHttpError",
            status: 502,
            statusCode: 502,
            requestId: "req-vydra-broken-body",
          }
        : { message: "broken body" },
    );
  });

  it.each([
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as a downloaded video", async ({ contentType, body }) => {
    await expect(
      download(respond(body, { status: 200, headers: { "content-type": contentType } }), {
        kind: "video",
      }),
    ).rejects.toThrow("Vydra video download: malformed video response");
  });

  it("keeps valid downloads alive beyond the binary reader's default idle timeout", async () => {
    vi.useFakeTimers();
    const fetchFn = respond(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
      { headers: { "content-type": "video/mp4" } },
    );
    const result = download(fetchFn, {
      kind: "video",
      timeoutMs: 45_000,
      maxBytes: 1024,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
  });
});

it("preserves URL priority, traversal bounds and independent result arrays", () => {
  const url = (file: string) => `https://cdn.example/${file}`;
  let data: Record<string, unknown> = {
    imageUrl: url("edge.png"),
    data: { imageUrl: url("too-deep.png") },
  };
  for (let depth = 1; depth < 5; depth++) {
    data = { data };
  }
  const payload = {
    audioUrl: url("other.mp3"),
    videoUrl: url("other.mp4"),
    imageUrls: [url("second.png"), [` ${url("first.png")} `]],
    imageUrl: ` \t${url("first.png")}\n`,
    url: url("shared.png"),
    resultUrl: url("result.png"),
    outputs: [
      { imageUrl: url("second.png"), url: url("nested.png") },
      [[{ imageUrl: url("array.png") }]],
    ],
    data,
  };
  const expected = ["first", "second", "result", "shared", "nested", "array", "edge"].map((name) =>
    url(`${name}.png`),
  );

  const urls = extractVydraResultUrls(payload, "image");
  expect(urls).toEqual(expected);
  urls.push(url("caller-owned.png"));
  expect(extractVydraResultUrls(payload, "image")).toEqual(expected);
});
