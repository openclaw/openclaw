import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { beginTelegramPollRegistration } from "./poll-answer-context.js";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import { openTelegramIngressQueue, resolveTelegramUpdateId } from "./telegram-ingress-spool.js";
import { getPreparedTelegramWidgetQuery } from "./widgets/widget-query-context.js";
import { recordTelegramSentWidget } from "./widgets/widget-store.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-"));
  setTelegramRuntime({
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStoreV2: <StoreValue>(
        options: Parameters<typeof createPluginStateKeyedStoreForTests<StoreValue>>[1],
      ) =>
        createPluginStateKeyedStoreForTests<StoreValue>("telegram", options).withCurrent({
          assertCurrent: () => {},
        }),
      openSyncKeyedStore: <StoreValue>(
        options: Parameters<typeof createPluginStateSyncKeyedStoreForTests<StoreValue>>[1],
      ) => createPluginStateSyncKeyedStoreForTests<StoreValue>("telegram", options),
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as never);
  try {
    return await fn(stateDir);
  } finally {
    clearTelegramRuntimeForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const chat = {
  id: -100123,
  type: "supergroup" as const,
  title: "Reviewers",
  is_forum: true as const,
};
const sender = { id: 111, first_name: "Ada" };
function pollEntry(pollId: string) {
  return {
    pollId,
    chat,
    messageId: 40,
    threadSpec: { scope: "forum" as const, id: 99 },
    question: "Ready?",
    options: ["Yes", "No"],
  };
}
function vote(pollId: string) {
  return { update_id: 9, poll_answer: { poll_id: pollId, option_ids: [0], user: sender } };
}
function message(updateId: number, topic: number) {
  return {
    update_id: updateId,
    message: {
      chat,
      from: sender,
      is_topic_message: true,
      message_id: updateId + 31,
      message_thread_id: topic,
      text: "after vote",
    },
  };
}
function createMonitor(stateDir: string, voteReleased?: Promise<void>) {
  const dispatchOrder: number[] = [];
  const onError = vi.fn();
  const queue = openTelegramIngressQueue({ accountId: "acct", stateDir });
  const monitor = createTelegramIngressMonitor({
    queue,
    getConfig: () => ({ channels: { telegram: { groupPolicy: "open" } } }) as OpenClawConfig,
    accountId: "acct",
    ...(voteReleased ? { onError } : {}),
    dispatch: async (update) => {
      const updateId = resolveTelegramUpdateId(update);
      if (updateId === null) {
        throw new Error("Expected update id");
      }
      dispatchOrder.push(updateId);
      if (updateId === 9 && voteReleased) {
        await voteReleased;
      }
      return { kind: "completed" };
    },
  });
  return { dispatchOrder, onError, queue, monitor };
}

describe("telegram ingress spool ordering", () => {
  it("keeps a poll vote ahead of a later message from the same topic", async () => {
    await withTempState(async (stateDir) => {
      await recordTelegramPollRegistryEntry({
        accountId: "acct",
        ...pollEntry("poll-topic-order"),
      });
      const { promise: voteReleased, resolve: releaseVote } = createDeferred<void>();
      const { dispatchOrder, onError, queue, monitor } = createMonitor(stateDir, voteReleased);

      monitor.start();
      try {
        await monitor.waitForIdle();
        const admissions = await Promise.all([
          monitor.admit(vote("poll-topic-order")),
          monitor.admit(message(10, 99)),
        ]);
        expect(admissions.map((result) => result.kind)).toEqual(["durable", "durable"]);
        await monitor.waitForPumpIdle();
        await vi.waitFor(() => expect(dispatchOrder).toEqual([9]));
        expect(onError).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "0000000000000009",
            laneKey: "telegram:-100123:topic:99",
            payload: expect.objectContaining({
              preparedPollAnswer: {
                entry: expect.objectContaining({ threadSpec: { scope: "forum", id: 99 } }),
              },
            }),
          }),
        ]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: "0000000000000010", laneKey: "telegram:-100123:topic:99" },
        ]);
        releaseVote();
        await monitor.waitForIdle();
        expect(dispatchOrder).toEqual([9, 10]);
      } finally {
        releaseVote();
        await monitor.stop();
      }
    });
  });

  it("fences a pending poll vote to its topic without blocking unrelated admission", async () => {
    await withTempState(async (stateDir) => {
      const entry = pollEntry("poll-pending-topic");
      const { dispatchOrder, queue, monitor } = createMonitor(stateDir);
      const registration = beginTelegramPollRegistration({ accountId: "acct", entry });

      try {
        monitor.start();
        await monitor.waitForIdle();
        const admissions = await Promise.all([
          monitor.admit(vote(entry.pollId)),
          monitor.admit(message(10, 100)),
          monitor.admit(message(11, 99)),
        ]);
        expect(admissions.map(({ kind }) => kind)).toEqual(["durable", "durable", "durable"]);
        await vi.waitFor(() => expect(dispatchOrder).toEqual([10]));
        expect(await queue.listClaims()).toMatchObject([{ laneKey: "telegram:-100123:topic:99" }]);

        registration.complete(entry);
        await monitor.waitForIdle();
        expect(dispatchOrder).toContain(9);
        expect(dispatchOrder.indexOf(9)).toBeLessThan(dispatchOrder.indexOf(11));
      } finally {
        // Release pending delivery before waiting for the monitor to stop.
        registration.complete(null);
        await monitor.stop();
      }
    });
  });
  it("keeps a widget tap ahead of a later message in the widget's private topic", async () => {
    await withTempState(async (stateDir) => {
      const dm = { id: 7, type: "private" as const, first_name: "Ada" };
      await recordTelegramSentWidget({
        accountId: "acct",
        chatId: "7",
        messageId: 50,
        widget: { name: "vote", title: "Vote", sourceHash: "h", messageThreadId: 42 },
      });
      const { promise: tapReleased, resolve: releaseTap } = createDeferred<void>();
      const dispatchOrder: number[] = [];
      const queue = openTelegramIngressQueue({ accountId: "acct", stateDir });
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => ({}) as OpenClawConfig,
        accountId: "acct",
        botInfo: { id: 1, is_bot: true, first_name: "Bot", has_topics_enabled: true } as never,
        dispatch: async (update) => {
          const updateId = resolveTelegramUpdateId(update);
          dispatchOrder.push(updateId ?? -1);
          if (updateId === 20) {
            await tapReleased;
          }
          return { kind: "completed" };
        },
      });
      monitor.start();
      try {
        await monitor.waitForIdle();
        await monitor.admit({
          update_id: 20,
          widget_query: {
            id: "q20",
            from: sender,
            chat: dm,
            message_id: 50,
            chat_instance: "1",
            data: "vote:v",
          },
        });
        await monitor.admit({
          update_id: 21,
          message: {
            chat: dm,
            from: sender,
            message_id: 60,
            message_thread_id: 42,
            is_topic_message: true,
            date: 0,
            text: "/new",
          },
        });
        await vi.waitFor(() => expect(dispatchOrder).toEqual([20]));
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            laneKey: "telegram:7:topic:42",
            payload: expect.objectContaining({ preparedWidgetQuery: { messageThreadId: 42 } }),
          }),
        ]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: "0000000000000021", laneKey: "telegram:7:topic:42" },
        ]);
        releaseTap();
        await monitor.waitForIdle();
        expect(dispatchOrder).toEqual([20, 21]);
      } finally {
        releaseTap();
        await monitor.stop();
      }
    });
  });
  it("restores a queued widget tap's topic from the spool after a restart", async () => {
    await withTempState(async (stateDir) => {
      const dm = { id: 7, type: "private" as const, first_name: "Ada" };
      const widget = { name: "vote", title: "Vote", sourceHash: "h" };
      await recordTelegramSentWidget({
        accountId: "acct",
        chatId: "7",
        messageId: 50,
        widget: { ...widget, messageThreadId: 42 },
      });
      const botInfo = { id: 1, is_bot: true, first_name: "Bot", has_topics_enabled: true } as never;
      const startMonitor = (
        dispatch: Parameters<typeof createTelegramIngressMonitor>[0]["dispatch"],
      ) =>
        createTelegramIngressMonitor({
          queue: openTelegramIngressQueue({ accountId: "acct", stateDir }),
          getConfig: () => ({}) as OpenClawConfig,
          accountId: "acct",
          botInfo,
          dispatch,
        });
      // The first process admits the tap and a later topic message, then stops mid-dispatch.
      const firstDispatched: (number | null)[] = [];
      const { promise: interrupted, resolve: interrupt } = createDeferred<void>();
      const first = startMonitor(async (update) => {
        firstDispatched.push(resolveTelegramUpdateId(update));
        await interrupted;
        return { kind: "failed-retryable", error: new Error("stopped before the tap turn") };
      });
      first.start();
      await first.waitForIdle();
      await first.admit({
        update_id: 20,
        widget_query: { id: "q20", from: sender, chat: dm, message_id: 50, data: "vote:v" },
      });
      await first.admit({
        update_id: 21,
        message: {
          chat: dm,
          from: sender,
          message_id: 60,
          message_thread_id: 42,
          is_topic_message: true,
          date: 0,
          text: "/new",
        },
      });
      await vi.waitFor(() => expect(firstDispatched).toEqual([20]));
      const stopped = first.stop();
      interrupt();
      await stopped;
      // A later record change must not move the queued tap: its topic comes from the spool.
      await recordTelegramSentWidget({
        accountId: "acct",
        chatId: "7",
        messageId: 50,
        widget: { ...widget, messageThreadId: 99 },
      });

      const dispatched: { updateId: number | null; topic?: number }[] = [];
      const restarted = startMonitor(async (update) => {
        dispatched.push({
          updateId: resolveTelegramUpdateId(update),
          topic: getPreparedTelegramWidgetQuery(update as object)?.messageThreadId,
        });
        return { kind: "completed" };
      });
      restarted.start();
      try {
        await vi.waitFor(() => expect(dispatched).toHaveLength(2), { timeout: 15_000 });
        expect(dispatched).toEqual([
          { updateId: 20, topic: 42 },
          { updateId: 21, topic: undefined },
        ]);
      } finally {
        await restarted.stop();
      }
    });
  });
});
