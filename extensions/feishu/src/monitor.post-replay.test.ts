// Preserve lifecycle mocks before loading the real monitor and bot.
// oxfmt-ignore
import { getFeishuLifecycleTestMocks, resetFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import { once } from "node:events";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
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
  createFeishuTextMessageEvent,
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
      ...mocks,
      storePath: `${state.stateDir}/sessions.json`,
    });
    runtime.config.current = () => cfg;
    const queueOptions = { channelId: "feishu", accountId: "test", stateDir: state.stateDir };
    const ingressReady = createDeferred<(eventId: string) => Promise<boolean>>();
    runtime.state.openChannelIngressQueue = <T, M = unknown, C = unknown>() => {
      const ingressQueue = createChannelIngressQueueForTests<T, M, C>(queueOptions);
      ingressReady.resolve((eventId) =>
        observeChannelIngressQueueWrite(ingressQueue, "complete", eventId),
      );
      return ingressQueue;
    };
    const queue = createChannelIngressQueueForTests(queueOptions);
    const controller = new AbortController();
    const ready = createDeferred<EventDispatcher>();
    mocks.monitorWebSocketMock.mockImplementation(async (...args: unknown[]) => {
      const transport = args[0] as { eventDispatcher: EventDispatcher };
      ready.resolve(transport.eventDispatcher);
      await once(controller.signal, "abort");
    });
    // A shipped attachment-free post record survives process-memory reset.
    const legacy = { messageId: "om-legacy", namespace: "test" };
    expect(await finalizeFeishuMessageProcessing(legacy)).toBe(true);
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
      const observeCompletion = await ingressReady.promise;
      let sequence = 0;
      const send = async (
        messageId: string,
        expectedReplies: number,
        createTime = "1758000000000",
        media: { imageKey?: string; fileKey?: string } = {},
      ) => {
        sequence += 1;
        const eventId = `evt-post-${sequence}`;
        const completed = observeCompletion(eventId);
        const event = createFeishuTextMessageEvent({
          messageId,
          chatId: "oc-post",
          senderOpenId: "ou-user",
          text: "Hello rich post",
        });
        const elements = [
          { tag: "text", text: "Hello rich post", style: ["bold"] },
          ...(media.imageKey ? [{ tag: "img", image_key: media.imageKey }] : []),
        ];
        event.message.message_type = "post";
        event.message.create_time = createTime;
        event.message.content = JSON.stringify({
          en_us: { title: "", content: [elements] },
          ...(media.fileKey
            ? { files: [{ file_key: media.fileKey, file_name: "report.csv" }] }
            : {}),
        });
        await dispatcher.invoke({
          schema: "2.0",
          header: { event_id: eventId, event_type: "im.message.receive_v1" },
          event,
        });
        await expect(completed).resolves.toBe(true);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        // Ingress adoption clears the queue before reply delivery settles.
        await Promise.all(mocks.withReplyDispatcherMock.mock.results.map((result) => result.value));
        expect(mocks.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(expectedReplies);
      };
      await send("om-first", 1);
      await send("om-reconnected", 1);
      await send("om-legacy", 1, "1758000000001");
      await send("om-legacy", 1, "1758000000001", { fileKey: "file_report" });
      await send("om-different", 2, "1758000000002");
      expect(
        mocks.createFeishuReplyDispatcherMock.mock.results.map(
          (result) => result.value.delivery.deliver.mock.calls.length,
        ),
      ).toEqual([1, 1]);
      // A legacy raw-ID hit must not suppress an attachment-bearing revision.
      await send("om-legacy", 3, "1758000000001", { imageKey: "img_fixture" });
      await send("om-legacy", 3, "1758000000001", { imageKey: "img_fixture" });
      await send("om-media-fresh-id", 4, "1758000000001", { imageKey: "img_fixture" });
    } finally {
      controller.abort();
      await monitor;
      await closeOpenClawStateDatabaseAsync();
      feishuDedupeState.reset();
      vi.restoreAllMocks();
    }
  });
});
