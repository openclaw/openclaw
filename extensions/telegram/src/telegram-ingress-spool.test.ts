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

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-"));
  const openKeyedStoreV2 = <StoreValue>(
    options: Parameters<typeof createPluginStateKeyedStoreForTests<StoreValue>>[1],
  ) =>
    createPluginStateKeyedStoreForTests<StoreValue>("telegram", options).withCurrent({
      assertCurrent: () => {},
    });
  setTelegramRuntime({
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStoreV2,
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
function message(updateId: number, topic: number, text: string) {
  return {
    update_id: updateId,
    message: {
      chat,
      from: sender,
      is_topic_message: true,
      message_id: updateId + 31,
      message_thread_id: topic,
      text,
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
      const messageUpdate = message(10, 99, "after vote");
      const { promise: voteReleased, resolve: releaseVote } = createDeferred<void>();
      const { dispatchOrder, onError, queue, monitor } = createMonitor(stateDir, voteReleased);

      monitor.start();
      try {
        await monitor.waitForIdle();
        const admissions = await Promise.all([
          monitor.admit(vote("poll-topic-order")),
          monitor.admit(messageUpdate),
        ]);
        expect(admissions.map((result) => result.kind)).toEqual(["durable", "durable"]);
        await monitor.waitForPumpIdle();
        await vi.waitFor(() => expect(dispatchOrder).toEqual([9]));
        expect(onError).not.toHaveBeenCalled();
        const preparedPollAnswer = {
          entry: expect.objectContaining({ threadSpec: { scope: "forum", id: 99 } }),
        };
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "0000000000000009",
            laneKey: "telegram:-100123:topic:99",
            payload: expect.objectContaining({ preparedPollAnswer }),
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
      const registration = beginTelegramPollRegistration({ accountId: "acct", entry });
      const unrelatedUpdate = message(10, 100, "unrelated topic");
      const sameTopicUpdate = message(11, 99, "after vote");
      const { dispatchOrder, queue, monitor } = createMonitor(stateDir);

      monitor.start();
      await monitor.waitForIdle();
      await expect(
        Promise.all([
          monitor.admit(vote(entry.pollId)),
          monitor.admit(unrelatedUpdate),
          monitor.admit(sameTopicUpdate),
        ]),
      ).resolves.toMatchObject([{ kind: "durable" }, { kind: "durable" }, { kind: "durable" }]);
      await vi.waitFor(() => expect(dispatchOrder).toContain(10));
      expect(dispatchOrder).not.toContain(9);
      expect(dispatchOrder).not.toContain(11);
      expect(await queue.listClaims()).toMatchObject([{ laneKey: "telegram:-100123:topic:99" }]);

      registration.complete(entry);
      await monitor.waitForIdle();
      expect(dispatchOrder.indexOf(9)).toBeLessThan(dispatchOrder.indexOf(11));
      await monitor.stop();
    });
  });
});
