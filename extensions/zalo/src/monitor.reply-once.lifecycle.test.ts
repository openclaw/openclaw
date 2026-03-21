import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import {
  createLifecycleAccount,
  createLifecycleConfig,
  createTextUpdate,
  getZaloRuntimeMock,
  postWebhookUpdate,
  resetLifecycleTestState,
  sendMessageMock,
  settleAsyncWork,
  startWebhookLifecycleMonitor,
} from "../../../test/helpers/extensions/zalo-lifecycle.js";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { PluginRuntime } from "../runtime-api.js";

describe("Zalo reply-once lifecycle", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const resolveAgentRouteMock = vi.fn(() => ({
    agentId: "main",
    channel: "zalo",
    accountId: "acct-zalo-lifecycle",
    sessionKey: "agent:main:zalo:direct:dm-chat-1",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  }));
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeEach(() => {
    resetLifecycleTestState();

    getZaloRuntimeMock.mockReturnValue(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute:
              resolveAgentRouteMock as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
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
        },
      }),
    );
  });

  afterEach(() => {
    resetLifecycleTestState();
  });

  it("routes one accepted webhook event to one visible reply across duplicate replay", async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "zalo reply once" });
      },
    );

    const { abort, route, run } = await startWebhookLifecycleMonitor({
      account: createLifecycleAccount({
        accountId: "acct-zalo-lifecycle",
        dmPolicy: "open",
      }),
      config: createLifecycleConfig({
        accountId: "acct-zalo-lifecycle",
        dmPolicy: "open",
      }),
    });

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate({
          messageId: `zalo-replay-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
        });
        const first = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });
        const second = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        await settleAsyncWork();
      },
    );

    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1);
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-zalo-lifecycle",
        SessionKey: "agent:main:zalo:direct:dm-chat-1",
        MessageSid: expect.stringContaining("zalo-replay-"),
        From: "zalo:user-1",
        To: "zalo:dm-chat-1",
      }),
    );
    expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:zalo:direct:dm-chat-1",
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      expect.objectContaining({
        chat_id: "dm-chat-1",
        text: "zalo reply once",
      }),
      undefined,
    );

    abort.abort();
    await run;
  });

  it("does not emit a second visible reply when replay arrives after a post-send failure", async () => {
    let dispatchAttempts = 0;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        dispatchAttempts += 1;
        await dispatcherOptions.deliver({ text: "zalo reply after failure" });
        if (dispatchAttempts === 1) {
          throw new Error("post-send failure");
        }
      },
    );

    const { abort, route, run, runtime } = await startWebhookLifecycleMonitor({
      account: createLifecycleAccount({
        accountId: "acct-zalo-lifecycle",
        dmPolicy: "open",
      }),
      config: createLifecycleConfig({
        accountId: "acct-zalo-lifecycle",
        dmPolicy: "open",
      }),
    });

    await withServer(
      (req, res) => route.handler(req, res),
      async (baseUrl) => {
        const payload = createTextUpdate({
          messageId: `zalo-retry-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
        });
        const first = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });
        await settleAsyncWork();
        const replay = await postWebhookUpdate({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        await settleAsyncWork();
      },
    );

    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Zalo webhook failed: Error: post-send failure"),
    );

    abort.abort();
    await run;
  });
});
