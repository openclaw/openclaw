import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitHttpError } from "../urbit/errors.js";
import { createTlonIngressMonitor } from "./ingress.js";

type TlonIngressPayload = {
  version: 1;
  receivedAt: number;
  source: "channels" | "chat";
  rawEvent: string;
};
type TlonIngressQueue = ReturnType<typeof createQueue>;
type TlonIngressDispatch = Parameters<typeof createTlonIngressMonitor>[0]["dispatch"];

const { openChannelIngressQueue } = vi.hoisted(() => ({ openChannelIngressQueue: vi.fn() }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  getTlonRuntime: () => ({ state: { openChannelIngressQueue } }),
}));

function essay(author = "~nec", text = "hello") {
  return { author, content: [{ text }], sent: 1_700_000_000_000 };
}

function channelEvent(id = "message-1") {
  return {
    nest: "chat/~zod/general",
    response: {
      post: {
        id,
        "r-post": { set: { essay: essay() } },
      },
    },
  };
}

function channelReplyEvent(id: string, nest: string) {
  return {
    nest,
    response: {
      post: {
        id: "parent-post",
        "r-post": {
          reply: { id, "r-reply": { set: { memo: essay() } } },
        },
      },
    },
  };
}

function chatEvent(id: string) {
  return { whom: "~nec", id, response: { add: { essay: essay() } } };
}

function createQueue(stateDir: string, accountId = "default") {
  return createChannelIngressQueueForTests<TlonIngressPayload>({
    channelId: "tlon",
    accountId,
    stateDir,
  });
}

async function withQueue<T>(
  fn: (queue: TlonIngressQueue, stateDir: string, start: typeof startMonitor) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tlon-ingress-"));
  const stateDir = await fs.realpath(created);
  const monitors: ReturnType<typeof startMonitor>[] = [];
  try {
    return await fn(createQueue(stateDir), stateDir, (queue, dispatch) => {
      const monitor = startMonitor(queue, dispatch);
      monitors.push(monitor);
      return monitor;
    });
  } finally {
    for (const monitor of monitors) {
      await monitor.stop();
    }
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startMonitor(queue: TlonIngressQueue, dispatch: TlonIngressDispatch) {
  openChannelIngressQueue.mockReturnValue(queue);
  const monitor = createTlonIngressMonitor({
    accountId: "default",
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  monitor.start();
  return monitor;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Tlon durable ingress", () => {
  it("propagates durable append failure before dispatch", async () => {
    await withQueue(async (queue, _stateDir, start) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies TlonIngressQueue;
      const dispatch = vi.fn();
      const monitor = start(failingQueue, dispatch);
      await expect(monitor.receive({ source: "channels", event: channelEvent() })).rejects.toBe(
        appendError,
      );
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("recovers an uncompleted message with a fresh drain exactly once", async () => {
    await withQueue(async (queue, stateDir, start) => {
      const interruptedDispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const interrupted = start(queue, interruptedDispatch);
      await interrupted.receive({
        source: "channels",
        event: channelEvent("message-restart"),
      });
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();
      closeOpenClawStateDatabaseForTest();

      const recoveredDispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = start(createQueue(stateDir), recoveredDispatch);
      await recovered.waitForIdle();
      expect(recoveredDispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("retains completed logical ids by count rather than age", async () => {
    await withQueue(async (queue, _stateDir, start) => {
      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = start(queue, dispatch);
      const original = channelEvent("message-aged");
      await monitor.receive({ source: "channels", event: original });
      await monitor.waitForIdle();

      now += 31 * 24 * 60 * 60 * 1_000;
      await monitor.receive({
        source: "channels",
        event: channelEvent("message-prune-trigger"),
      });
      await monitor.waitForIdle();
      await monitor.receive({ source: "channels", event: original });
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });

  it("uses the nested reply id rather than the parent post id", async () => {
    await withQueue(async (queue, _stateDir, start) => {
      const dispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const monitor = start(queue, dispatch);
      const reply = channelReplyEvent("reply-stable", "chat/~zod/ops");
      await monitor.receive({ source: "channels", event: reply });
      await monitor.waitForIdle();
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({ id: "reply-stable", laneKey: "group:chat/~zod/ops" }),
      ]);
    });
  });

  it("dead-letters malformed persisted payloads and authentication failures", async () => {
    await withQueue(async (queue, _stateDir, start) => {
      await queue.enqueue(
        "message-malformed",
        { version: 1, receivedAt: 1, source: "channels", rawEvent: "{" },
        { receivedAt: 1, laneKey: "group:chat/~zod/general" },
      );
      const dispatch = vi.fn<TlonIngressDispatch>(async () => {
        throw new UrbitHttpError({ operation: "Poke", status: 401 });
      });
      const monitor = start(queue, dispatch);
      await monitor.waitForIdle();
      expect((await queue.enqueue("message-malformed", {} as TlonIngressPayload)).kind).toBe(
        "failed",
      );

      await monitor.receive({
        source: "chat",
        event: chatEvent("message-auth"),
      });
      await monitor.waitForIdle();
      expect((await queue.enqueue("message-auth", {} as TlonIngressPayload)).kind).toBe("failed");
    });
  });

  it("keeps unrelated authentication failures retryable", async () => {
    await withQueue(async (queue, _stateDir, start) => {
      const dispatch = vi.fn<TlonIngressDispatch>(async () => {
        throw Object.assign(new Error("model credentials expired"), { status: 401 });
      });
      const monitor = start(queue, dispatch);
      await monitor.receive({
        source: "chat",
        event: chatEvent("message-provider-auth"),
      });
      await monitor.waitForIdle();
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "message-provider-auth",
      ]);
    });
  });

  it("waits for admitted work and leaves it pending on repeated stop", async () => {
    await withQueue(async (queue) => {
      const stored = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        const result = await enqueue(...args);
        stored.resolve();
        await release.promise;
        return result;
      };
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      const admission = monitor.receive({
        source: "channels",
        event: channelEvent("message-stop-1"),
      });
      await stored.promise;
      const queuedAdmission = monitor.receive({
        source: "channels",
        event: channelEvent("message-stop-2"),
      });

      let stopSettled = false;
      const stopping = monitor.stop().then(() => {
        stopSettled = true;
      });
      const stoppingAgain = monitor.stop();
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      await expect(
        monitor.receive({ source: "channels", event: channelEvent("message-too-late") }),
      ).rejects.toThrow("stopped before dispatch adoption");

      release.resolve();
      await Promise.all([admission, queuedAdmission, stopping, stoppingAgain]);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "message-stop-1",
        "message-stop-2",
      ]);
    });
  });
});
