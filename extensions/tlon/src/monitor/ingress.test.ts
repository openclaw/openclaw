// Tlon durable ingress tests cover append, recovery, tombstones, and guard parity.
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

type TlonIngressQueue = NonNullable<Parameters<typeof createTlonIngressMonitor>[0]["queue"]>;
type TlonIngressPayload = Parameters<TlonIngressQueue["enqueue"]>[1];
type TlonIngressDispatch = Parameters<typeof createTlonIngressMonitor>[0]["dispatch"];

function channelEvent(params?: { id?: string; nest?: string; text?: string }) {
  return {
    nest: params?.nest ?? "chat/~zod/general",
    response: {
      post: {
        id: params?.id ?? "message-1",
        "r-post": {
          set: {
            essay: {
              author: "~nec",
              content: [{ text: params?.text ?? "hello" }],
              sent: 1_700_000_000_000,
            },
          },
        },
      },
    },
  };
}

function channelReplyEvent(params?: { id?: string; nest?: string; text?: string }) {
  return {
    nest: params?.nest ?? "chat/~zod/general",
    response: {
      post: {
        id: "parent-post",
        "r-post": {
          reply: {
            id: params?.id ?? "reply-1",
            "r-reply": {
              set: {
                memo: {
                  author: "~nec",
                  content: [{ text: params?.text ?? "hello" }],
                  sent: 1_700_000_000_000,
                },
              },
            },
          },
        },
      },
    },
  };
}

function chatEvent(params?: { id?: string; peer?: string; author?: string; text?: string }) {
  const peer = params?.peer ?? "~nec";
  return {
    whom: peer,
    id: params?.id ?? "dm-1",
    response: {
      add: {
        essay: {
          author: params?.author ?? peer,
          content: [{ text: params?.text ?? "hello" }],
          sent: 1_700_000_000_000,
        },
      },
    },
  };
}

function createQueue(stateDir: string, accountId = "default"): TlonIngressQueue {
  return createChannelIngressQueueForTests<TlonIngressPayload>({
    channelId: "tlon",
    accountId,
    stateDir,
  });
}

async function withQueue<T>(
  fn: (queue: TlonIngressQueue, stateDir: string) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tlon-ingress-"));
  const stateDir = await fs.realpath(created);
  try {
    return await fn(createQueue(stateDir), stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startMonitor(queue: TlonIngressQueue, dispatch: TlonIngressDispatch) {
  const monitor = createTlonIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  monitor.start();
  return monitor;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Tlon durable ingress", () => {
  it("propagates durable append failure before dispatch", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies TlonIngressQueue;
      const dispatch = vi.fn();
      const monitor = startMonitor(failingQueue, dispatch);
      try {
        await expect(monitor.receive({ source: "channels", event: channelEvent() })).rejects.toBe(
          appendError,
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers an uncompleted message with a fresh drain exactly once", async () => {
    await withQueue(async (queue, stateDir) => {
      const interruptedDispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const interrupted = startMonitor(queue, interruptedDispatch);
      await interrupted.receive({
        source: "channels",
        event: channelEvent({ id: "message-restart" }),
      });
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();
      closeOpenClawStateDatabaseForTest();

      const recoveredDispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startMonitor(createQueue(stateDir), recoveredDispatch);
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("persists club events on the authenticated conversation lane", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const monitor = startMonitor(queue, dispatch);
      try {
        await expect(
          monitor.receive({
            source: "chat",
            event: chatEvent({
              id: "club-forged-owner",
              peer: "0v3.q4n5m.6r7s8.9t0u1.2v3w4",
              author: "~nec",
            }),
          }),
        ).resolves.toEqual({ kind: "accepted" });
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "club-forged-owner",
            laneKey: "club:0v3.q4n5m.6r7s8.9t0u1.2v3w4",
          }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("retains completion so a duplicate message id cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        const event = chatEvent({ id: "dm-completed" });
        await monitor.receive({ source: "chat", event });
        await monitor.waitForIdle();
        await monitor.receive({ source: "chat", event });
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("preserves the retired guard for reissued or edited message envelopes", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive({
          source: "channels",
          event: channelEvent({ id: "message-guard", text: "first delivery" }),
        });
        await monitor.waitForIdle();
        await monitor.receive({
          source: "channels",
          event: channelEvent({ id: "message-guard", text: "edited redelivery" }),
        });
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("retains completed logical ids by count rather than age", async () => {
    await withQueue(async (queue) => {
      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        const original = channelEvent({ id: "message-aged" });
        await monitor.receive({ source: "channels", event: original });
        await monitor.waitForIdle();

        now += 31 * 24 * 60 * 60 * 1_000;
        await monitor.receive({
          source: "channels",
          event: channelEvent({ id: "message-prune-trigger" }),
        });
        await monitor.waitForIdle();
        await monitor.receive({ source: "channels", event: original });
        await monitor.waitForIdle();

        expect(dispatch).toHaveBeenCalledTimes(2);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("stores raw envelopes in per-conversation lanes", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const monitor = startMonitor(queue, dispatch);
      const group = channelEvent({ id: "message-raw", nest: "chat/~zod/ops" });
      try {
        await monitor.receive({ source: "channels", event: group });
        await monitor.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "message-raw",
            laneKey: "group:chat/~zod/ops",
            payload: expect.objectContaining({ rawEvent: JSON.stringify(group) }),
          }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("canonicalizes new bare-peer DMs behind a pre-upgrade raw-lane backlog", async () => {
    await withQueue(async (queue) => {
      const legacy = chatEvent({ id: "legacy-bare-peer", peer: "nec" });
      await queue.enqueue(
        "legacy-bare-peer",
        {
          version: 1,
          receivedAt: 1,
          source: "chat",
          rawEvent: JSON.stringify(legacy),
        },
        { receivedAt: 1, laneKey: "direct:nec" },
      );
      const releaseLegacy = deferred();
      const delivered: string[] = [];
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, event, lifecycle) => {
        const id = (event as { id: string }).id;
        delivered.push(id);
        if (id === "legacy-bare-peer") {
          await releaseLegacy.promise;
        }
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await vi.waitFor(() => expect(delivered).toEqual(["legacy-bare-peer"]));
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ id: "legacy-bare-peer", laneKey: "direct:~nec" }),
        ]);

        await monitor.receive({
          source: "chat",
          event: chatEvent({ id: "new-bare-peer", peer: "nec" }),
        });
        await vi.waitFor(async () => {
          expect(
            (await queue.listPending({ limit: "all" })).map((record) => [
              record.id,
              record.laneKey,
            ]),
          ).toContainEqual(["new-bare-peer", "direct:~nec"]);
        });
        expect(delivered).toEqual(["legacy-bare-peer"]);

        releaseLegacy.resolve();
        await monitor.waitForIdle();
        expect(delivered).toEqual(["legacy-bare-peer", "new-bare-peer"]);
      } finally {
        releaseLegacy.resolve();
        await monitor.stop();
      }
    });
  });

  it("serializes new club events behind a pre-upgrade author lane", async () => {
    await withQueue(async (queue) => {
      const clubId = "0v3.q4n5m.6r7s8.9t0u1.2v3w4";
      const legacy = chatEvent({
        id: "legacy-club-event",
        peer: clubId,
        author: "~nec",
      });
      await queue.enqueue(
        "legacy-club-event",
        {
          version: 1,
          receivedAt: 1,
          source: "chat",
          rawEvent: JSON.stringify(legacy),
        },
        { receivedAt: 1, laneKey: "direct:~nec" },
      );
      const releaseLegacy = deferred();
      const delivered: string[] = [];
      const dispatch = vi.fn<TlonIngressDispatch>(async (_source, event, lifecycle) => {
        const id = (event as { id: string }).id;
        delivered.push(id);
        if (id === "legacy-club-event") {
          await releaseLegacy.promise;
        }
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await vi.waitFor(() => expect(delivered).toEqual(["legacy-club-event"]));
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "legacy-club-event",
            laneKey: `club:${clubId}`,
          }),
        ]);

        await monitor.receive({
          source: "chat",
          event: chatEvent({ id: "new-club-event", peer: clubId, author: "~bus" }),
        });
        await vi.waitFor(async () => {
          expect(
            (await queue.listPending({ limit: "all" })).map((record) => [
              record.id,
              record.laneKey,
            ]),
          ).toContainEqual(["new-club-event", `club:${clubId}`]);
        });
        expect(delivered).toEqual(["legacy-club-event"]);

        releaseLegacy.resolve();
        await monitor.waitForIdle();
        expect(delivered).toEqual(["legacy-club-event", "new-club-event"]);
      } finally {
        releaseLegacy.resolve();
        await monitor.stop();
      }
    });
  });

  it("uses the nested reply id rather than the parent post id", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
      const monitor = startMonitor(queue, dispatch);
      const reply = channelReplyEvent({ id: "reply-stable", nest: "chat/~zod/ops" });
      try {
        await monitor.receive({ source: "channels", event: reply });
        await monitor.waitForIdle();
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ id: "reply-stable", laneKey: "group:chat/~zod/ops" }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters malformed persisted payloads and authentication failures", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "message-malformed",
        { version: 1, receivedAt: 1, source: "channels", rawEvent: "{" },
        { receivedAt: 1, laneKey: "group:chat/~zod/general" },
      );
      const dispatch = vi.fn<TlonIngressDispatch>(async () => {
        throw new UrbitHttpError({ operation: "Poke", status: 401 });
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.waitForIdle();
        expect((await queue.enqueue("message-malformed", {} as TlonIngressPayload)).kind).toBe(
          "failed",
        );

        await monitor.receive({
          source: "chat",
          event: chatEvent({ id: "message-auth" }),
        });
        await monitor.waitForIdle();
        expect((await queue.enqueue("message-auth", {} as TlonIngressPayload)).kind).toBe("failed");
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps unrelated authentication failures retryable", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn<TlonIngressDispatch>(async () => {
        throw Object.assign(new Error("model credentials expired"), { status: 401 });
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive({
          source: "chat",
          event: chatEvent({ id: "message-provider-auth" }),
        });
        await monitor.waitForIdle();
        expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
          "message-provider-auth",
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("waits for admitted work and leaves it pending on repeated stop", async () => {
    await withQueue(async (queue) => {
      const stored = deferred();
      const release = deferred();
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
        event: channelEvent({ id: "message-stop-1" }),
      });
      await stored.promise;
      const queuedAdmission = monitor.receive({
        source: "channels",
        event: channelEvent({ id: "message-stop-2" }),
      });

      let stopSettled = false;
      const stopping = monitor.stop().then(() => {
        stopSettled = true;
      });
      const stoppingAgain = monitor.stop();
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      await expect(
        monitor.receive({ source: "channels", event: channelEvent({ id: "message-too-late" }) }),
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
