// Zalo tests cover durable ingress journaling, replay, and dedupe.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZaloUpdate } from "./api.js";
import {
  createZaloIngressSpool,
  type ZaloIngressSpool,
  type ZaloIngressTurnLifecycle,
} from "./monitor-ingress.js";

type ZaloIngressPayload = {
  version: 1;
  receivedAt: number;
  update: ZaloUpdate;
};

type ZaloIngressDispatch = (
  update: ZaloUpdate,
  lifecycle: ZaloIngressTurnLifecycle,
) => Promise<void>;

const stateDirs: string[] = [];
const disposers: Array<() => void> = [];

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalo-ingress-"));
  const resolved = await realpath(created);
  stateDirs.push(resolved);
  return resolved;
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<ZaloIngressPayload>({
    channelId: "zalo",
    accountId: "default",
    stateDir,
  });
}

function createTextUpdate(params?: { messageId?: string; chatId?: string; userId?: string }) {
  return {
    event_name: "message.text.received",
    message: {
      message_id: params?.messageId ?? "msg-1",
      from: { id: params?.userId ?? "user-1", name: "Test User" },
      chat: { id: params?.chatId ?? "chat-1", chat_type: "PRIVATE" as const },
      date: 1_774_080_000,
      text: "hello from zalo",
    },
  } satisfies ZaloUpdate;
}

function createSpool(params: {
  stateDir: string;
  dispatch: ZaloIngressDispatch;
  retryPolicy?: Parameters<typeof createZaloIngressSpool>[0]["retryPolicy"];
}): ZaloIngressSpool {
  const spool = createZaloIngressSpool({
    accountId: "default",
    abortSignal: new AbortController().signal,
    queue: createQueue(params.stateDir),
    dispatch: params.dispatch,
    ...(params.retryPolicy ? { retryPolicy: params.retryPolicy } : {}),
  });
  disposers.push(spool.dispose);
  return spool;
}

async function drainSpool(spool: ZaloIngressSpool): Promise<void> {
  await spool.drainOnce();
  await spool.waitForIdle();
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("createZaloIngressSpool", () => {
  it("replays a journaled update after a crash before dispatch", async () => {
    // Loss window: the Bot API consumes the update on response, then the process
    // dies before processUpdate runs. The journaled row must survive and replay.
    const stateDir = await createStateDir();
    const crashed = createSpool({
      stateDir,
      dispatch: vi.fn<ZaloIngressDispatch>(async () => {
        throw new Error("must never dispatch before the crash");
      }),
    });
    await crashed.enqueue(createTextUpdate({ messageId: "msg-crash-window" }));
    crashed.dispose();

    const dispatch = vi.fn<ZaloIngressDispatch>(async (_update, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = createSpool({ stateDir, dispatch });
    await drainSpool(recovered);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].message?.message_id).toBe("msg-crash-window");
  });

  it("tombstones after dispatch so a redelivered update never dispatches twice", async () => {
    const stateDir = await createStateDir();
    const dispatch = vi.fn<ZaloIngressDispatch>(async (_update, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const spool = createSpool({ stateDir, dispatch });

    expect(await spool.enqueue(createTextUpdate())).toEqual({ kind: "accepted" });
    await drainSpool(spool);
    expect(await spool.enqueue(createTextUpdate())).toEqual({ kind: "duplicate" });
    await drainSpool(spool);

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("completes at dispatch return when the turn never adopts", async () => {
    // Sticker/unsupported events and pre-dispatch drops (unauthorized, empty text)
    // never reach the turn lifecycle; they must still tombstone at dispatch return.
    const stateDir = await createStateDir();
    const dispatch = vi.fn<ZaloIngressDispatch>(async () => undefined);
    const spool = createSpool({ stateDir, dispatch });

    await spool.enqueue(createTextUpdate());
    await drainSpool(spool);
    expect(await spool.enqueue(createTextUpdate())).toEqual({ kind: "duplicate" });

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("retries a failed dispatch instead of dropping the update", async () => {
    const stateDir = await createStateDir();
    let attempts = 0;
    const dispatch = vi.fn<ZaloIngressDispatch>(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("dispatch boom");
      }
    });
    const spool = createSpool({
      stateDir,
      dispatch,
      retryPolicy: { baseMs: 1, maxMs: 5 },
    });

    await spool.enqueue(createTextUpdate());
    await drainSpool(spool);
    expect(dispatch).toHaveBeenCalledOnce();

    await vi.waitFor(async () => {
      await spool.drainOnce();
      await spool.waitForIdle();
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
    expect(await spool.enqueue(createTextUpdate())).toEqual({ kind: "duplicate" });
  });

  it("dead-letters a permanently invalid payload instead of retrying forever", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const dispatch = vi.fn<ZaloIngressDispatch>(async () => undefined);
    const spool = createSpool({ stateDir, dispatch });

    const eventId = JSON.stringify(["chat-1", "user-1", "msg-corrupt"]);
    await queue.enqueue(
      eventId,
      {
        version: 99,
        receivedAt: Date.now(),
        update: createTextUpdate(),
      } as unknown as ZaloIngressPayload,
      { receivedAt: Date.now(), laneKey: "chat:chat-1" },
    );
    await drainSpool(spool);

    expect(dispatch).not.toHaveBeenCalled();
    expect(await queue.listPending()).toEqual([]);
  });

  it("ignores updates that cannot be journaled", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const dispatch = vi.fn<ZaloIngressDispatch>(async () => undefined);
    const spool = createZaloIngressSpool({
      accountId: "default",
      abortSignal: new AbortController().signal,
      queue,
      dispatch,
    });
    disposers.push(spool.dispose);

    expect(await spool.enqueue({ event_name: "message.text.received" })).toEqual({
      kind: "ignored",
    });
    expect(await queue.listPending()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the same message id in different chats distinct", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const dispatch = vi.fn<ZaloIngressDispatch>(async () => undefined);
    const spool = createZaloIngressSpool({
      accountId: "default",
      abortSignal: new AbortController().signal,
      queue,
      dispatch,
    });
    disposers.push(spool.dispose);

    expect(await spool.enqueue(createTextUpdate({ chatId: "chat-a" }))).toEqual({
      kind: "accepted",
    });
    expect(await spool.enqueue(createTextUpdate({ chatId: "chat-b" }))).toEqual({
      kind: "accepted",
    });
    expect(await queue.listPending()).toHaveLength(2);
  });

  it("serializes one lane per chat", async () => {
    const stateDir = await createStateDir();
    const queue = createQueue(stateDir);
    const spool = createZaloIngressSpool({
      accountId: "default",
      abortSignal: new AbortController().signal,
      queue,
      dispatch: vi.fn<ZaloIngressDispatch>(async () => undefined),
    });
    disposers.push(spool.dispose);

    await spool.enqueue(createTextUpdate({ chatId: "group-9", messageId: "msg-lane" }));

    expect(await queue.listPending()).toEqual([
      expect.objectContaining({ laneKey: "chat:group-9" }),
    ]);
  });
});
