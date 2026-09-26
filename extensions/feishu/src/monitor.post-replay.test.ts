// Preserve lifecycle mocks before loading the real monitor and bot.
// oxfmt-ignore
import { getFeishuLifecycleTestMocks, resetFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { feishuDedupeState } from "./dedup-state.js";
import { finalizeFeishuMessageProcessing, hasProcessedFeishuMessage } from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
} from "./test-support/lifecycle-test-support.js";

it("suppresses rich-post transport twins and retained legacy records without blocking a different post", async () => {
  await withOpenClawTestState({ label: "feishu-post-replay" }, async (state) => {
    resetFeishuLifecycleTestMocks();
    const mocks = getFeishuLifecycleTestMocks();
    const cfg = createFeishuLifecycleConfig({
      accountId: "test",
      appId: "fixture-app",
      appSecret: "fixture-secret",
      channelConfig: { groupPolicy: "open" },
    });
    mocks.createEventDispatcherMock.mockImplementation(() => new EventDispatcher({}));
    mocks.createFeishuReplyDispatcherMock.mockImplementation(createFeishuLifecycleReplyDispatcher);
    mocks.resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "test",
      sessionKey: "agent:main:feishu:group:oc-post",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock: mocks.dispatchReplyFromConfigMock,
      replyText: "scripted post reply",
    });
    const runtime = installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock: mocks.resolveAgentRouteMock,
      dispatchReplyFromConfigMock: mocks.dispatchReplyFromConfigMock,
      withReplyDispatcherMock: mocks.withReplyDispatcherMock,
      storePath: `${state.stateDir}/sessions.json`,
    });
    runtime.config.current = () => cfg;
    runtime.state.openChannelIngressQueue = () =>
      createChannelIngressQueueForTests({
        channelId: "feishu",
        accountId: "test",
        stateDir: state.stateDir,
      });
    const queue = createChannelIngressQueueForTests({
      channelId: "feishu",
      accountId: "test",
      stateDir: state.stateDir,
    });
    const controller = new AbortController();
    const ready = createDeferred<EventDispatcher>();
    mocks.monitorWebSocketMock.mockImplementation(async (...args: unknown[]) => {
      const transport = args[0] as { eventDispatcher: EventDispatcher };
      ready.resolve(transport.eventDispatcher);
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    // A shipped attachment-free post record survives process-memory reset.
    expect(
      await finalizeFeishuMessageProcessing({ messageId: "om-legacy", namespace: "test" }),
    ).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    feishuDedupeState.reset();
    expect(await hasProcessedFeishuMessage("om-legacy", "test")).toBe(true);
    const monitor = monitorSingleAccount({
      cfg,
      account: resolveFeishuAccount({ cfg, accountId: "test" }),
      runtime: createNonExitingRuntimeEnv(),
      abortSignal: controller.signal,
      fireAndForget: false,
      botOpenIdSource: { kind: "prefetched", botOpenId: "ou-bot", source: "provider" },
    });
    void monitor.catch(ready.reject);
    try {
      const dispatcher = await ready.promise;
      let sequence = 0;
      const send = async (messageId: string, createTime = "1758000000000", imageKey?: string) => {
        sequence += 1;
        await dispatcher.invoke({
          schema: "2.0",
          header: { event_id: `evt-post-${sequence}`, event_type: "im.message.receive_v1" },
          event: {
            sender: { sender_id: { open_id: "ou-user" }, sender_type: "user" },
            message: {
              message_id: messageId,
              chat_id: "oc-post",
              chat_type: "group",
              message_type: "post",
              create_time: createTime,
              content: JSON.stringify({
                en_us: {
                  title: "",
                  content: [
                    [
                      { tag: "text", text: "Hello rich post", style: ["bold"] },
                      ...(imageKey ? [{ tag: "img", image_key: imageKey }] : []),
                    ],
                  ],
                },
              }),
            },
          },
        });
        await vi.waitFor(async () => {
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
        });
      };
      await send("om-first");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      await send("om-reconnected");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      await send("om-legacy", "1758000000001");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      await send("om-different", "1758000000002");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
      expect(
        mocks.createFeishuReplyDispatcherMock.mock.results.map(
          (result) => result.value.delivery.deliver.mock.calls.length,
        ),
      ).toEqual([1, 1]);
      // A legacy raw-ID hit must not suppress an attachment-bearing revision.
      await send("om-legacy", "1758000000001", "img_fixture");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(3);
      await send("om-legacy", "1758000000001", "img_fixture");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(3);
      await send("om-media-fresh-id", "1758000000001", "img_fixture");
      expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(4);
    } finally {
      controller.abort();
      await monitor;
      await closeOpenClawStateDatabaseAsync();
      feishuDedupeState.reset();
      vi.restoreAllMocks();
    }
  });
});
