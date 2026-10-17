// Zalo regression coverage for unsupported inbound webhook events.
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

describe("Zalo unsupported lifecycle", () => {
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
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
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

  function requireRecordInboundSessionArgs() {
    const [call] = recordInboundSessionMock.mock.calls;
    if (!call) {
      throw new Error("expected inbound session record call");
    }
    const [recordArgs] = call;
    return recordArgs;
  }

  it("dispatches recoverable text from an unsupported webhook event", async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({
        dispatcherOptions,
        replyOptions,
      }: {
        dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
        replyOptions: { turnAdoptionLifecycle?: { onAdopted: () => Promise<void> } };
      }) => {
        await replyOptions.turnAdoptionLifecycle?.onAdopted();
        await dispatcherOptions.deliver({ text: "zalo unsupported reply" });
      },
    );
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-unsupported",
      dmPolicy: "open",
    });
    const monitor = await startWebhookLifecycleMonitor({
      account,
      config,
      cacheKey: "zalo-unsupported-lifecycle",
    });

    try {
      await withServer(
        (req, res) => {
          void monitor.route.handler(req, res);
        },
        async (baseUrl) => {
          const response = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createUnsupportedUpdate({
              messageId: `zalo-unsupported-text-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
              chatId: "dm-unsupported-1",
              text: "test https://example.com",
            }),
            beforeReplay: monitor.waitForIdle,
          });
          expect(response.first.status).toBe(200);
          await monitor.waitForIdle();
        },
      );

      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
      expect(requireRecordInboundSessionArgs()?.ctx?.BodyForAgent).toBe("test https://example.com");
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, sendPayload] = sendMessageMock.mock.calls[0] as [
        string,
        { chat_id?: string; text?: string },
      ];
      expect(sendPayload.chat_id).toBe("dm-unsupported-1");
      expect(sendPayload.text).toBe("zalo unsupported reply");
    } finally {
      await monitor.stop();
    }
  });

  it("sends resend guidance once when an unsupported event has no text", async () => {
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-unsupported",
      dmPolicy: "open",
    });
    const monitor = await startWebhookLifecycleMonitor({
      account,
      config,
      cacheKey: "zalo-unsupported-lifecycle",
    });

    try {
      await withServer(
        (req, res) => {
          void monitor.route.handler(req, res);
        },
        async (baseUrl) => {
          const response = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createUnsupportedUpdate({
              messageId: `zalo-unsupported-guidance-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
              chatId: "dm-unsupported-1",
            }),
            beforeReplay: monitor.waitForIdle,
          });
          expect(response.first.status).toBe(200);
          expect(response.replay.status).toBe(200);
          await monitor.waitForIdle();
        },
      );

      expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      expect(monitor.runtime.error).not.toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [sendToken, sendPayload] = sendMessageMock.mock.calls[0] as [
        string,
        { chat_id?: string; text?: string },
      ];
      expect(sendToken).toBe("zalo-token");
      expect(sendPayload.chat_id).toBe("dm-unsupported-1");
      expect(sendPayload.text).toMatch(/resend.*text or an image/i);
    } finally {
      await monitor.stop();
    }
  });

  it("does not send fallback guidance to blocked senders", async () => {
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "acct-zalo-unsupported-blocked",
      dmPolicy: "open",
      allowFrom: ["other-user"],
    });
    const monitor = await startWebhookLifecycleMonitor({
      account,
      config,
      cacheKey: "zalo-unsupported-lifecycle",
    });

    try {
      await withServer(
        (req, res) => {
          void monitor.route.handler(req, res);
        },
        async (baseUrl) => {
          const response = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createUnsupportedUpdate({
              messageId: `zalo-unsupported-blocked-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
              chatId: "dm-unsupported-blocked",
            }),
            beforeReplay: monitor.waitForIdle,
          });
          expect(response.first.status).toBe(200);
          await monitor.waitForIdle();
        },
      );

      expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
