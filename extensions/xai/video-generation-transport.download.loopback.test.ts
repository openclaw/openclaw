// Loopback / hang-floor proof for xAI generated-video body reads.
import { once } from "node:events";
import http from "node:http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutGuardedMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  };
});

describe("downloadXaiVideo", () => {
  let server: http.Server | undefined;
  const dripTimers = new Set<ReturnType<typeof setTimeout>>();

  afterEach(async () => {
    vi.restoreAllMocks();
    fetchWithTimeoutGuardedMock.mockReset();
    for (const timer of dripTimers) {
      clearTimeout(timer);
    }
    dripTimers.clear();
    if (!server) {
      return;
    }
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
    server = undefined;
  });

  it("rejects a stalled body with the download-owned idle timeout", async () => {
    const totalTimeoutMs = 50;
    const idleTimeoutMs = Math.ceil(totalTimeoutMs / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        // Never close — idle timeout must cancel the reader.
      },
    });
    fetchWithTimeoutGuardedMock.mockResolvedValue({
      response: new Response(body, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
      release: async () => {},
    });

    const { downloadXaiVideo } = await import("./video-generation-transport.js");
    const startedAt = performance.now();
    await expect(
      downloadXaiVideo({
        url: "https://cdn.example.com/generated/video.mp4",
        timeoutMs: totalTimeoutMs,
        defaultTimeoutMs: totalTimeoutMs,
        fetchFn: fetch,
        maxBytes: 1024 * 1024,
        allowPrivateNetwork: false,
      }),
    ).rejects.toThrow(`xAI generated video download stalled after ${idleTimeoutMs}ms`);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(idleTimeoutMs - 20);
    expect(elapsedMs).toBeLessThan(totalTimeoutMs + 1_500);
  });

  it("rejects a continuously dripping CDN body within the guarded request deadline", async () => {
    // Real wire proof: fetchWithSsrFGuard keeps its abort until release(), so a drip cannot hang
    // forever even though chunk idle resets. Use the unmocked transport path via dynamic import
    // after restoring the real provider-http module.
    vi.resetModules();
    vi.doUnmock("openclaw/plugin-sdk/provider-http");
    const { downloadXaiVideo } = await import("./video-generation-transport.js");

    const timeoutMs = 250;
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Transfer-Encoding": "chunked",
      });
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(Buffer.from([0x00]));
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

    const startedAt = performance.now();
    await expect(
      downloadXaiVideo({
        url: `http://127.0.0.1:${address.port}/generated/video.mp4`,
        timeoutMs,
        defaultTimeoutMs: timeoutMs,
        fetchFn: fetch,
        maxBytes: 1024 * 1024,
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/request timed out|stalled after|timed out after/i);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
  });

  it("does not bound a dripping body when only chunk idle timeout is used", async () => {
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Transfer-Encoding": "chunked",
      });
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(Buffer.from([0x00]));
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

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    let settled = false;
    void readResponseWithLimit(response, 1024 * 1024, {
      chunkTimeoutMs: 100,
      onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`idle fired after ${chunkTimeoutMs}ms`),
    })
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(settled).toBe(false);
  });

  it("rejects a stalled body with the idle deadline before the guarded request deadline in an unmocked loopback", async () => {
    vi.resetModules();
    vi.doUnmock("openclaw/plugin-sdk/provider-http");
    const { downloadXaiVideo } = await import("./video-generation-transport.js");

    const totalTimeoutMs = 300;
    const idleTimeoutMs = Math.ceil(totalTimeoutMs / 2);
    server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "9999999",
      });
      // Send initial bytes so the body reader starts, then stall.
      res.write(Buffer.from([0x00, 0x00]));
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }

    const startedAt = performance.now();
    await expect(
      downloadXaiVideo({
        url: `http://127.0.0.1:${address.port}/generated/video.mp4`,
        timeoutMs: totalTimeoutMs,
        defaultTimeoutMs: totalTimeoutMs,
        fetchFn: fetch,
        maxBytes: 1024 * 1024,
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(`xAI generated video download stalled after ${idleTimeoutMs}ms`);
    const elapsedMs = performance.now() - startedAt;

    // Must settle near idleTimeoutMs, well below totalTimeoutMs.
    expect(elapsedMs).toBeGreaterThanOrEqual(idleTimeoutMs - 30);
    expect(elapsedMs).toBeLessThan(totalTimeoutMs - 50);
  });
});
