import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
} from "./test-support/lifecycle-test-support.js";
import {
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

type Reply = PluginRuntime["channel"]["reply"];
type Session = PluginRuntime["channel"]["session"];

describe("Zalo reply-once lifecycle", () => {
  const textUpdate = createTextUpdate({
    messageId: "zalo-replay",
    userId: "user-1",
    userName: "User One",
    chatId: "dm-chat-1",
    text: "check https://example.com",
  });
  const finalizeContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordSession = vi.fn(
    async (_input: { sessionKey?: string; ctx?: Record<string, unknown> }) => undefined,
  );
  const dispatchReply = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-reply-once-lifecycle");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      reply: {
        finalizeInboundContext: finalizeContext as unknown as Reply["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReply as unknown as Reply["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession: recordSession as unknown as Session["recordInboundSession"],
      },
    });
  });

  afterAll(resetLifecycleTestState);

  function startMonitor() {
    const setup = createLifecycleMonitorSetup({
      accountId: "acct-zalo-lifecycle",
      dmPolicy: "open",
    });
    return startWebhookLifecycleMonitor({
      ...setup,
      cacheKey: "zalo-reply-once-lifecycle",
      config: {
        ...setup.config,
        session: { dmScope: "per-channel-peer" as const },
      },
    });
  }

  async function replayWebhook(
    monitor: Awaited<ReturnType<typeof startWebhookLifecycleMonitor>>,
    payload: Record<string, unknown>,
    waitBeforeReplay = false,
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
          ...(waitBeforeReplay ? { beforeReplay: monitor.waitForIdle } : {}),
        });
        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        await monitor.waitForIdle();
      },
    );
  }

  it.each(["message.text.received", "message.unsupported.received"])(
    "routes %s text to one visible reply across duplicate replay",
    async (eventName) => {
      dispatchReply.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions.turnAdoptionLifecycle?.onAdopted();
        await dispatcherOptions.deliver({ text: "zalo reply once" });
      });

      const monitor = await startMonitor();

      try {
        await replayWebhook(monitor, { ...textUpdate, event_name: eventName });

        expect(dispatchReply).toHaveBeenCalledTimes(1);
        expect(dispatchReply.mock.calls[0]?.[0].ctx.BodyForAgent).toBe("check https://example.com");
        expect(recordSession).toHaveBeenCalledTimes(1);
        const recordArgs = recordSession.mock.calls[0]?.[0];
        expect(recordArgs).toMatchObject({
          sessionKey: "agent:main:zalo:direct:dm-chat-1",
          ctx: {
            AccountId: "acct-zalo-lifecycle",
            SessionKey: "agent:main:zalo:direct:dm-chat-1",
            From: "zalo:user-1",
            To: "zalo:dm-chat-1",
          },
        });
        expect(recordArgs?.ctx?.MessageSid).toBe("zalo-replay");
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        const [token, payload, options] = sendMessageMock.mock.calls[0]!;
        expect([token, payload, options]).toEqual([
          "zalo-token",
          expect.objectContaining({ chat_id: "dm-chat-1", text: "zalo reply once" }),
          undefined,
        ]);
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each([undefined, " \t "])(
    "logs unsupported events with no usable text (%j) without sending a reply",
    async (text) => {
      const monitor = await startMonitor();
      try {
        await replayWebhook(
          monitor,
          {
            ...textUpdate,
            event_name: "message.unsupported.received",
            message: { ...textUpdate.message, text },
          },
          true,
        );

        expect(monitor.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Zalo unsupported message has no recoverable text"),
        );
        expect(dispatchReply).not.toHaveBeenCalled();
        expect(recordSession).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it("does not emit a second visible reply when replay arrives after a post-send failure", async () => {
    let dispatchAttempts = 0;
    dispatchReply.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
      dispatchAttempts += 1;
      expect(replyOptions.turnAdoptionLifecycle).toBeDefined();
      await replyOptions.turnAdoptionLifecycle?.onAdopted();
      await dispatcherOptions.deliver({ text: "zalo reply after failure" });
      if (dispatchAttempts === 1) {
        throw new Error("post-send failure");
      }
    });

    const monitor = await startMonitor();

    try {
      await replayWebhook(monitor, textUpdate, true);

      expect(dispatchReply).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
