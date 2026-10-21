import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createUnsupportedUpdate,
  postWebhookReplay,
} from "./test-support/lifecycle-test-support.js";
import {
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

const UNSUPPORTED_NOTICE =
  "Sorry, I can't read that kind of Zalo message. Please resend its content as plain text.";

describe("Zalo unsupported-event lifecycle", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(
    async (_input: { sessionKey?: string; ctx?: Record<string, unknown> }) => undefined,
  );
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-unsupported-lifecycle");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions.turnAdoptionLifecycle?.onAdopted();
        await dispatcherOptions.deliver({ text: "zalo unsupported agent reply" });
      },
    );
    setLifecycleRuntimeCore({
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
    });
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  function startOpenMonitor() {
    return startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "acct-zalo-unsupported", dmPolicy: "open" }),
      cacheKey: "zalo-unsupported-lifecycle",
    });
  }

  async function postEvent(
    monitor: Awaited<ReturnType<typeof startOpenMonitor>>,
    payload: Record<string, unknown>,
    options: { replay?: boolean } = {},
  ) {
    await withServer(
      (req, res) => {
        void monitor.route.handler(req, res);
      },
      async (baseUrl) => {
        const { first, replay } = await postWebhookReplay({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
          beforeReplay: options.replay ? monitor.waitForIdle : undefined,
        });
        expect([first.status, replay.status]).toEqual([200, 200]);
        await monitor.waitForIdle();
      },
    );
  }

  it("routes an unsupported event that still carries text through the authorized agent pipeline once", async () => {
    const monitor = await startOpenMonitor();
    try {
      const payload = createUnsupportedUpdate({
        messageId: "zalo-unsupported-text-1",
        userId: "user-1",
        userName: "User One",
        chatId: "dm-unsupported-1",
        text: "check https://example.com",
        messageType: "complex_link_preview",
      });
      await postEvent(monitor, payload, { replay: true });

      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
      const recordArgs = recordInboundSessionMock.mock.calls[0]?.[0] as {
        ctx?: Record<string, unknown>;
      };
      expect(recordArgs?.ctx?.MessageSid).toBe("zalo-unsupported-text-1");
    } finally {
      await monitor.stop();
    }
  });

  it("sends one resend-guidance notice when an authorized unsupported event has no text", async () => {
    const monitor = await startOpenMonitor();
    try {
      const payload = createUnsupportedUpdate({
        messageId: "zalo-unsupported-notext-1",
        userId: "user-1",
        userName: "User One",
        chatId: "dm-unsupported-2",
        messageType: "sticker_gif",
      });
      await postEvent(monitor, payload, { replay: true });

      expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0]).toEqual([
        "zalo-token",
        { chat_id: "dm-unsupported-2", text: UNSUPPORTED_NOTICE },
        undefined,
      ]);
    } finally {
      await monitor.stop();
    }
  });

  it("neither dispatches nor notifies when the sender is blocked", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({
        accountId: "acct-zalo-unsupported-blocked",
        dmPolicy: "disabled",
      }),
      cacheKey: "zalo-unsupported-lifecycle",
    });
    try {
      const payload = createUnsupportedUpdate({
        messageId: "zalo-unsupported-blocked-1",
        userId: "user-blocked",
        userName: "Blocked User",
        chatId: "dm-unsupported-3",
        text: "check https://example.com",
      });
      await postEvent(monitor, payload);

      expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });

  it("retries the guidance notice when the first send fails transiently", async () => {
    const monitor = await startOpenMonitor();
    let sendAttempts = 0;
    sendMessageMock.mockImplementation(async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error("transient send failure");
      }
      return { ok: true, result: { message_id: "zalo-unsupported-notice-retry" } } as unknown;
    });
    try {
      const payload = createUnsupportedUpdate({
        messageId: "zalo-unsupported-retry-1",
        userId: "user-1",
        userName: "User One",
        chatId: "dm-unsupported-4",
        messageType: "sticker_gif",
      });
      await postEvent(monitor, payload, { replay: true });

      // The first transient failure must not tombstone the event as complete; the
      // replay is re-delivered and the guidance is sent once it succeeds.
      expect(sendAttempts).toBeGreaterThanOrEqual(2);
      expect(sendMessageMock).toHaveBeenLastCalledWith(
        "zalo-token",
        { chat_id: "dm-unsupported-4", text: UNSUPPORTED_NOTICE },
        undefined,
      );
    } finally {
      await monitor.stop();
    }
  });
});
