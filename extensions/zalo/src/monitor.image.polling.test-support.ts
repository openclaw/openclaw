// Zalo test support covers monitor.image.polling plugin behavior.
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createLifecycleMonitorSetup,
  expectImageLifecycleDelivery,
  postWebhookReplay,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  getZaloRuntimeMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

async function startImageMonitor(
  setup: Partial<Parameters<typeof createLifecycleMonitorSetup>[0]> = {},
  cacheKey = "zalo-image-polling",
) {
  const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(cacheKey);
  const abort = new AbortController();
  const { account, config } = createLifecycleMonitorSetup({
    accountId: "default",
    dmPolicy: "open",
    ...setup,
  });
  const run = monitorZaloProvider({
    token: "zalo-token",
    account,
    config,
    runtime: createRuntimeEnv(),
    abortSignal: abort.signal,
  });
  return { abort, run };
}

describe("Zalo polling image handling", () => {
  const {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    readRemoteMediaBufferMock,
    saveRemoteMediaMock,
    saveMediaBufferMock,
  } = createImageLifecycleCore();

  beforeEach(async () => {
    await resetLifecycleTestState();
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    const processed = Promise.withResolvers<void>();
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({ date: 1774084566880 }),
      })
      .mockImplementation(() => {
        processed.resolve();
        return new Promise(() => {});
      });

    const { abort, run } = await startImageMonitor({ allowFrom: [" zl:user-123 "] });

    await processed.promise;
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expectImageLifecycleDelivery({
      readRemoteMediaBufferMock,
      saveRemoteMediaMock,
      saveMediaBufferMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
    });
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Timestamp: 1774084566880,
        RawBody: "",
        CommandBody: "",
        BodyForAgent: "",
        media: [expect.objectContaining({ contentType: "image/jpeg" })],
      }),
    );

    abort.abort();
    await run;
  });

  it("downloads inbound image media through the registered webhook route", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({
        accountId: "default",
        dmPolicy: "open",
      }),
      cacheKey: "zalo-image-webhook",
    });

    try {
      await withServer(
        (req, res) => {
          void monitor.route.handler(req, res);
        },
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createImageUpdate({ messageId: `zalo-image-webhook-${Date.now()}` }),
          });
          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await monitor.waitForIdle();
        },
      );

      expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
      expectImageLifecycleDelivery({
        readRemoteMediaBufferMock,
        saveRemoteMediaMock,
        saveMediaBufferMock,
        finalizeInboundContextMock,
        recordInboundSessionMock,
      });
    } finally {
      await monitor.stop();
    }
  });

  it("rejects unauthorized DM images before downloading media", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({
          messageId: "msg-unauthorized-1",
          userId: "user-unauthorized-1",
          chatId: "chat-unauthorized-1",
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run } = await startImageMonitor({
      dmPolicy: "pairing",
      allowFrom: ["allowed-user"],
    });

    await settleAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
    expect(finalizeInboundContextMock).not.toHaveBeenCalled();
    expect(recordInboundSessionMock).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("dispatches an unavailable notice when the inbound image download fails", async () => {
    saveRemoteMediaMock.mockRejectedValueOnce(new Error("expired image URL"));
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({ caption: "/reset" }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run } = await startImageMonitor();

    await vi.waitFor(() => expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "/reset",
        CommandBody: "/reset",
        BodyForAgent: "/reset\n\n[zalo image attachment unavailable]",
        media: [expect.objectContaining({ kind: "image" })],
      }),
    );

    abort.abort();
    await run;
  });

  it("keeps failed media-only command text empty while preserving the native image fact", async () => {
    saveRemoteMediaMock.mockRejectedValueOnce(new Error("expired image URL"));
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: createImageUpdate() })
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run } = await startImageMonitor({}, "zalo-image-media-only-failure");

    await vi.waitFor(() => expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "",
        CommandBody: "",
        BodyForAgent: "[zalo image attachment unavailable]",
        media: [expect.objectContaining({ kind: "image" })],
      }),
    );

    abort.abort();
    await run;
  });

  it("times out inbound image downloads when photo_url headers never arrive", async () => {
    const { createServer } = await import("node:http");
    const { saveRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");

    const server = createServer((_req, _res) => {
      // Accept the connection but never write status/headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const stallUrl = `http://127.0.0.1:${address.port}/stall.jpg`;
    const headerTimeoutMs = 250;

    // Production monitor passes the full timeout budget; the harness shortens
    // only the actual fetch so the stalled-header case stays fast.
    const saveRemoteMediaWithHeaderTimeout: typeof saveRemoteMedia = async (params) => {
      expect(params).toEqual({
        url: stallUrl,
        maxBytes: 5 * 1024 * 1024,
        responseHeaderTimeoutMs: 120_000,
        readIdleTimeoutMs: 30_000,
      });
      return await saveRemoteMedia({
        ...params,
        responseHeaderTimeoutMs: headerTimeoutMs,
        ssrfPolicy: { ...params.ssrfPolicy, dangerouslyAllowPrivateNetwork: true },
      });
    };
    saveRemoteMediaMock.mockImplementation(saveRemoteMediaWithHeaderTimeout);

    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({
          caption: "stalled photo",
          photoUrl: stallUrl,
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-image-polling");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
    });
    const started = Date.now();
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
    expect(elapsedMs).toBeLessThan(headerTimeoutMs + 5_000);
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "stalled photo\n\n[zalo image attachment unavailable]",
        media: [expect.objectContaining({ kind: "image" })],
      }),
    );

    abort.abort();
    await run;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it.each([
    { mediaMaxMb: 0, expectedMaxBytes: 5 * 1024 * 1024 },
    { mediaMaxMb: -5, expectedMaxBytes: 5 * 1024 * 1024 },
    { mediaMaxMb: 2, expectedMaxBytes: 2 * 1024 * 1024 },
  ])(
    "caps inbound image downloads at $expectedMaxBytes bytes when mediaMaxMb is $mediaMaxMb",
    async ({ mediaMaxMb, expectedMaxBytes }) => {
      getUpdatesMock
        .mockResolvedValueOnce({
          ok: true,
          result: createImageUpdate({ messageId: `zalo-image-cap-${mediaMaxMb}` }),
        })
        .mockImplementation(() => new Promise(() => {}));

      const { abort, run } = await startImageMonitor({ mediaMaxMb });

      await settleAsyncWork();
      expect(saveRemoteMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({ maxBytes: expectedMaxBytes }),
      );

      abort.abort();
      await run;
    },
  );
});
