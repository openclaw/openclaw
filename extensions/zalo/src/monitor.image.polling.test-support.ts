import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createLifecycleMonitorSetup,
  expectImageLifecycleDelivery,
  queueLifecycleUpdate,
  replayLifecycleWebhook,
  startPollingLifecycleMonitor,
} from "./test-support/lifecycle-test-support.js";
import {
  getZaloRuntimeMock,
  resetLifecycleTestState,
  sendMessageMock,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

const startImageMonitor = (
  setup: Partial<Parameters<typeof createLifecycleMonitorSetup>[0]> = {},
) => startPollingLifecycleMonitor("zalo-image-polling", setup);

async function withImage(
  update: Parameters<typeof createImageUpdate>[0],
  check: (monitor: Awaited<ReturnType<typeof startImageMonitor>>) => void | Promise<void>,
  setup: Parameters<typeof startImageMonitor>[0] = {},
) {
  const processed = queueLifecycleUpdate(createImageUpdate(update));
  const monitor = await startImageMonitor(setup);
  try {
    await processed;
    await check(monitor);
  } finally {
    await monitor.stop();
  }
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

  afterAll(resetLifecycleTestState);

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    await withImage(
      { date: 1774084566880 },
      async () => {
        expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
        expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
        expectImageLifecycleDelivery(imageCore);
        expect(finalizeInboundContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            Timestamp: 1774084566880,
            RawBody: "",
            CommandBody: "",
            BodyForAgent: "",
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
      },
      { allowFrom: [" zl:user-123 "] },
    );
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
      await replayLifecycleWebhook(
        monitor,
        createImageUpdate({ messageId: `zalo-image-webhook-${Date.now()}` }),
      );

      expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
      expectImageLifecycleDelivery(imageCore);
    } finally {
      await monitor.stop();
    }
  });

  it("rejects unauthorized DM images before downloading media", async () => {
    await withImage(
      { userId: "unauthorized" },
      () => {
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
        expect(saveMediaBufferMock).not.toHaveBeenCalled();
        expect(saveRemoteMediaMock).not.toHaveBeenCalled();
        expect(finalizeInboundContextMock).not.toHaveBeenCalled();
        expect(recordInboundSessionMock).not.toHaveBeenCalled();
      },
      { dmPolicy: "pairing", allowFrom: ["allowed-user"] },
    );
  });

  it.each([
    ["/reset", "/reset\n\n[zalo image attachment unavailable]"],
    ["", "[zalo image attachment unavailable]"],
  ])(
    "preserves image facts and command text %j without logging the failed source",
    async (caption, body) => {
      const photoUrl = "https://example.com/private-zalo-photo.jpg?access=private-source-marker";
      saveRemoteMediaMock.mockRejectedValueOnce(
        new MediaFetchError("http_error", `Failed to fetch media from ${photoUrl}: HTTP 403`, {
          status: 403,
        }),
      );
      await withImage({ caption, photoUrl }, ({ runtime }) => {
        expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1);
        expect(finalizeInboundContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            RawBody: caption,
            CommandBody: caption,
            BodyForAgent: body,
            media: [expect.objectContaining({ kind: "image" })],
          }),
        );
        expect(runtime.error).toHaveBeenCalledWith("[default] Failed to download Zalo image");
        const diagnostics = [runtime.error, runtime.log]
          .flatMap((log) => vi.mocked(log).mock.calls)
          .flat()
          .join("\n");
        expect(diagnostics).not.toContain(photoUrl);
        expect(diagnostics).not.toContain("private-source-marker");
      });
    },
  );

  it.each([
    { mediaMaxMb: 0, expectedMaxBytes: 5 * 1024 * 1024 },
    { mediaMaxMb: 2, expectedMaxBytes: 2 * 1024 * 1024 },
  ])(
    "caps inbound image downloads at $expectedMaxBytes bytes when mediaMaxMb is $mediaMaxMb",
    async ({ mediaMaxMb, expectedMaxBytes }) => {
      await withImage(
        { messageId: `zalo-image-cap-${mediaMaxMb}` },
        () => {
          expect(saveRemoteMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({ maxBytes: expectedMaxBytes }),
          );
        },
        { mediaMaxMb },
      );
    },
  );
});
