// IRC durable ingress tests cover append ordering, local ids, recovery, and tombstones.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrcIngressMonitor } from "./irc-ingress.js";

type IrcIngressQueue = NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
type IrcIngressPayload = Parameters<IrcIngressQueue["enqueue"]>[1];
type IrcIngressDispatch = Parameters<typeof createIrcIngressMonitor>[0]["dispatch"];

const CHANNEL_LINE = ":alice!ident@example.org PRIVMSG #room :hello";

function createQueue(stateDir: string): IrcIngressQueue {
  return createChannelIngressQueueForTests<IrcIngressPayload>({
    channelId: "irc",
    accountId: "default",
    stateDir,
  });
}

async function withQueue<T>(fn: (queue: IrcIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-irc-ingress-"));
  const stateDir = await fs.realpath(created);
  try {
    return await fn(createQueue(stateDir));
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startIngress(queue: IrcIngressQueue, dispatch: IrcIngressDispatch) {
  const ingress = createIrcIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 10,
    adoptionStallTimeoutMs: 5_000,
  });
  ingress.start();
  return ingress;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("IRC durable ingress", () => {
  it("assigns distinct monotonic ids to identical lines on one connection", async () => {
    await withQueue(async (queue) => {
      const messageIds: string[] = [];
      const dispatch = vi.fn<IrcIngressDispatch>(async (message, lifecycle) => {
        messageIds.push(message.messageId);
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        const connection = ingress.openConnection("connection-identical");
        await connection.accept(CHANNEL_LINE, "bot");
        await connection.accept(CHANNEL_LINE, "bot");
        await ingress.waitForIdle();
        expect(messageIds).toEqual([
          "local:connection-identical:000000000001",
          "local:connection-identical:000000000002",
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("quiesces an active pump while paused and resumes without charging the next event", async () => {
    await withQueue(async (queue) => {
      const dispatchStarted = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const dispatch = vi.fn<IrcIngressDispatch>(async (message, lifecycle) => {
        if (message.messageId.endsWith("000000000001")) {
          dispatchStarted.resolve();
          await releaseDispatch.promise;
        }
        await lifecycle.onAdopted();
      });
      const ingress = startIngress(queue, dispatch);
      try {
        const connection = ingress.openConnection("connection-paused");
        await connection.accept(CHANNEL_LINE, "bot");
        await dispatchStarted.promise;
        let pauseSettled = false;
        const pausing = ingress.pause().then(() => {
          pauseSettled = true;
        });
        const secondAdmission = connection.accept(CHANNEL_LINE, "bot");
        await Promise.resolve();
        expect(pauseSettled).toBe(false);

        releaseDispatch.resolve();
        await Promise.all([pausing, secondAdmission]);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({
            id: "local:connection-paused:000000000002",
            attempts: 0,
          }),
        ]);

        ingress.start();
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(2);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters a malformed persisted raw line without dispatch", async () => {
    await withQueue(async (queue) => {
      const eventId = "local:connection-bad:000000000001";
      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      try {
        await ingress.openConnection("connection-bad").accept("not an IRC message", "bot");
        await ingress.waitForIdle();
        expect((await queue.enqueue(eventId, {} as IrcIngressPayload)).kind).toBe("failed");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("does not create a drain when stop wins an async prune race", async () => {
    await withQueue(async (queue) => {
      const pruneStarted = createDeferred<void>();
      const releasePrune = createDeferred<void>();
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        pruneStarted.resolve();
        await releasePrune.promise;
        return await prune(...args);
      };
      const dispatch = vi.fn();
      const ingress = startIngress(queue, dispatch);
      await pruneStarted.promise;
      const stopping = ingress.stop();
      releasePrune.resolve();
      await stopping;
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
