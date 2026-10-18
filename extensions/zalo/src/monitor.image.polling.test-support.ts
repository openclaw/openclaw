import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
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
  const runtime = createRuntimeEnv();
  const started = Date.now();
  const run = monitorZaloProvider({
    token: "zalo-token",
    account,
    config,
    runtime,
    abortSignal: abort.signal,
  });
  return { abort, run, runtime, started };
}

function queueImage(params?: Parameters<typeof createImageUpdate>[0]) {
  const processed = Promise.withResolvers<void>();
  getUpdatesMock
    .mockResolvedValueOnce({ ok: true, result: createImageUpdate(params) })
    .mockImplementation(() => {
      processed.resolve();
      return new Promise(() => {});
    });
  return processed.promise;
}

describe("Zalo polling image handling", () => {
  const imageCore = createImageLifecycleCore();
  const {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    readRemoteMediaBufferMock,
    saveRemoteMediaMock,
    saveMediaBufferMock,
  } = imageCore;

  beforeEach(async () => {
    await resetLifecycleTestState();
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    const processed = queueImage({ date: 1774084566880 });

    const { abort, run } = await startImageMonitor({ allowFrom: [" zl:user-123 "] });

    await processed;
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expectImageLifecycleDelivery(imageCore);
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Timestamp: 1774084566880,
        RawBody: "",
        CommandBody: "",
        BodyForAgent: "",
        media: [expect.objectContaining({ contentType: "image/jpeg" })],
      }),
    );

    const delivery = vi.mocked(core.channel.inbound.dispatch).mock.calls[0]?.[0].delivery;
    if (!delivery?.preparePayload || typeof delivery.durable !== "function") {
      throw new Error("expected Zalo reply preparation and durable delivery callbacks");
    }
    const convertMarkdownTables = vi.mocked(core.channel.text.convertMarkdownTables);
    convertMarkdownTables.mockReturnValueOnce("converted table");
    expect(await delivery.preparePayload({ text: "| a |\n| - |" }, { kind: "final" })).toEqual({
      text: "converted table",
    });
    expect(convertMarkdownTables).toHaveBeenCalledWith("| a |\n| - |", "code");
    expect(await delivery.durable({ text: "hello" }, { kind: "final" })).toEqual({
      to: "chat-123",
    });
    expect(
      await delivery.durable(
        { text: "photo", mediaUrl: "https://example.com/photo.jpg" },
        { kind: "final" },
      ),
    ).toBe(false);
    expect(await delivery.durable({ text: "hello" }, { kind: "block" })).toBe(false);

    abort.abort();
    await run;
  });

  it("downloads inbound image media through the registered webhook route", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open" }),
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
          expect([first.status, replay.status]).toEqual([200, 200]);
          await monitor.waitForIdle();
        },
      );

      expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
      expectImageLifecycleDelivery(imageCore);
    } finally {
      await monitor.stop();
    }
  });

  it("rejects unauthorized DM images before downloading media", async () => {
    queueImage({
      messageId: "msg-unauthorized-1",
      userId: "user-unauthorized-1",
      chatId: "chat-unauthorized-1",
    });

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

  it.each(["/reset", ""])(
    "preserves failed image facts and command text for caption %j",
    async (caption) => {
      const photoUrl = "https://example.com/private-zalo-photo.jpg?access=private-source-marker";
      saveRemoteMediaMock.mockRejectedValueOnce(
        caption
          ? new MediaFetchError("http_error", `Failed to fetch media from ${photoUrl}: HTTP 403`, {
              status: 403,
            })
          : new Error("expired image URL"),
      );
      const processed = queueImage(caption ? { caption, photoUrl } : undefined);
      const { abort, run, runtime } = await startImageMonitor(
        {},
        caption ? "zalo-image-polling" : "zalo-image-media-only-failure",
      );
      try {
        await processed;
        expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1);
        expect(finalizeInboundContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            RawBody: caption,
            CommandBody: caption,
            BodyForAgent: `${caption ? `${caption}\n\n` : ""}[zalo image attachment unavailable]`,
            media: [expect.objectContaining({ kind: "image" })],
          }),
        );
        if (caption) {
          expect(runtime.error).toHaveBeenCalledWith("[default] Failed to download Zalo image");
          const diagnostics = [runtime.error, runtime.log]
            .flatMap((log) => vi.mocked(log).mock.calls)
            .flat()
            .join("\n");
          expect(diagnostics).not.toContain(photoUrl);
          expect(diagnostics).not.toContain("private-source-marker");
        }
      } finally {
        abort.abort();
        await run;
      }
    },
  );

  it("times out inbound image downloads when photo_url headers never arrive", async () => {
    const { saveRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
    // Accept the connection without sending status/headers.
    await withServer(
      () => {},
      async (baseUrl) => {
        const stallUrl = `${baseUrl}/stall.jpg`;
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

        const processed = queueImage({ caption: "stalled photo", photoUrl: stallUrl });
        const { abort, run, started } = await startImageMonitor();

        try {
          await processed;
          expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1);
          const elapsedMs = Date.now() - started;
          expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
          expect(elapsedMs).toBeLessThan(headerTimeoutMs + 5_000);
          expect(finalizeInboundContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
              BodyForAgent: "stalled photo\n\n[zalo image attachment unavailable]",
              media: [expect.objectContaining({ kind: "image" })],
            }),
          );
        } finally {
          abort.abort();
          await run;
        }
      },
    );
  });

  it.each([
    { mediaMaxMb: 0, expectedMaxBytes: 5 * 1024 * 1024 },
    { mediaMaxMb: -5, expectedMaxBytes: 5 * 1024 * 1024 },
    { mediaMaxMb: 2, expectedMaxBytes: 2 * 1024 * 1024 },
  ])(
    "caps inbound image downloads at $expectedMaxBytes bytes when mediaMaxMb is $mediaMaxMb",
    async ({ mediaMaxMb, expectedMaxBytes }) => {
      queueImage({ messageId: `zalo-image-cap-${mediaMaxMb}` });

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
