import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function channelEvent(id = "message-1", nest = "chat/~zod/general", reply = false) {
  return {
    nest,
    response: {
      post: {
        id: reply ? "parent-post" : id,
        "r-post": {
          set: { essay: reply ? essay("~bus", "parent essay") : essay() },
          ...(reply ? { reply: { id, "r-reply": { set: { memo: essay() } } } } : {}),
        },
      },
    },
  };
}

function chatEvent(id: string) {
  return { whom: "~nec", id, response: { add: { essay: essay() } } };
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<TlonIngressPayload>({
    channelId: "tlon",
    accountId: "default",
    stateDir,
  });
}

let stateDir: string;
let queue: TlonIngressQueue;
let monitors: ReturnType<typeof createTlonIngressMonitor>[];
beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tlon-ingress-"));
  stateDir = await fs.realpath(created);
  queue = createQueue(stateDir);
  monitors = [];
  adopt.mockClear();
});

function start(dispatch: TlonIngressDispatch, ingressQueue = queue) {
  openChannelIngressQueue.mockReturnValue(ingressQueue);
  const monitor = createTlonIngressMonitor({
    accountId: "default",
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  monitors.push(monitor);
  monitor.start();
  return monitor;
}

afterEach(async () => {
  for (const monitor of monitors) {
    await monitor.stop();
  }
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function receive(
  monitor: ReturnType<typeof start>,
  event: unknown,
  source: "channels" | "chat" = "channels",
) {
  await monitor.receive({ source, event });
  await monitor.waitForIdle();
}

const adopt = vi.fn<TlonIngressDispatch>(async (_source, _event, lifecycle) => {
  await lifecycle.onAdopted();
});

describe("Tlon durable ingress", () => {
  it("propagates durable append failure before dispatch", async () => {
    const appendError = new Error("sqlite unavailable");
    const dispatch = vi.fn();
    const monitor = start(dispatch, { ...queue, enqueue: vi.fn().mockRejectedValue(appendError) });
    await expect(monitor.receive({ source: "channels", event: channelEvent() })).rejects.toBe(
      appendError,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers an uncompleted message with a fresh drain exactly once", async () => {
    const interrupted = start(async () => ({ kind: "deferred" }));
    await receive(interrupted, channelEvent("message-restart"));
    expect(await queue.listClaims()).toHaveLength(1);
    await interrupted.stop();
    closeOpenClawStateDatabaseForTest();
    await start(adopt, createQueue(stateDir)).waitForIdle();
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("retains completed logical ids by count rather than age", async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const monitor = start(adopt);
    const original = channelEvent("message-aged");
    await receive(monitor, original);
    now += 31 * 24 * 60 * 60 * 1_000;
    await receive(monitor, channelEvent("message-prune-trigger"));
    await receive(monitor, original);
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "reply precedence and trimmed group identity preserve the delivered envelope",
      source: "channels" as const,
      event: channelEvent(" reply-padded ", " chat/~zod/ops ", true),
      id: "reply-padded",
      laneKey: "group:chat/~zod/ops",
    },
    {
      name: "direct identity trims without changing the delivered envelope",
      source: "chat" as const,
      event: { ...chatEvent(" dm-padded "), whom: { ship: " ~nec " } },
      id: "dm-padded",
      laneKey: "direct:~nec",
    },
  ])("preserves raw wire facts while $name", async ({ source, event, id, laneKey }) => {
    const dispatch = vi.fn(async () => ({ kind: "deferred" }) as const);
    await receive(start(dispatch), event, source);
    expect(await queue.listClaims()).toEqual([expect.objectContaining({ id, laneKey })]);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(source, event, expect.any(Object));
  });

  it("dead-letters malformed persisted payloads and authentication failures", async () => {
    await queue.enqueue(
      "message-malformed",
      { version: 1, receivedAt: 1, source: "channels", rawEvent: "{" },
      { receivedAt: 1, laneKey: "group:chat/~zod/general" },
    );
    const dispatch = vi.fn<TlonIngressDispatch>(async () => {
      throw new UrbitHttpError({ operation: "Poke", status: 401 });
    });
    const monitor = start(dispatch);
    await monitor.waitForIdle();
    expect((await queue.enqueue("message-malformed", {} as TlonIngressPayload)).kind).toBe(
      "failed",
    );

    await receive(monitor, chatEvent("message-auth"), "chat");
    expect((await queue.enqueue("message-auth", {} as TlonIngressPayload)).kind).toBe("failed");
  });

  it("keeps unrelated authentication failures retryable", async () => {
    const dispatch = vi.fn<TlonIngressDispatch>(async () => {
      throw Object.assign(new Error("model credentials expired"), { status: 401 });
    });
    await receive(start(dispatch), chatEvent("message-provider-auth"), "chat");
    expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
      "message-provider-auth",
    ]);
  });

  it("waits for admitted work and leaves it pending on repeated stop", async () => {
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
    const monitor = start(dispatch);
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
