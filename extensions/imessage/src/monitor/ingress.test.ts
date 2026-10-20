import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIMessageDurableIngress } from "./ingress.js";

type IMessageIngressQueue = NonNullable<
  Parameters<typeof createIMessageDurableIngress>[0]["queue"]
>;
type IMessageIngressPayload = Parameters<IMessageIngressQueue["enqueue"]>[1];

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      id: 101,
      guid: "GUID-101",
      chat_id: 42,
      sender: "+15550001111",
      text: "hello",
      created_at: "2026-07-17T10:00:00.000Z",
      is_from_me: false,
      ...overrides,
    },
  };
}

function createQueue(stateDir: string): IMessageIngressQueue {
  return createChannelIngressQueueForTests<IMessageIngressPayload>({
    channelId: "imessage",
    accountId: "default",
    stateDir,
  });
}

let stateDir: string;
let queue: IMessageIngressQueue;
let ingresses: ReturnType<typeof createIMessageDurableIngress>[];

beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-ingress-"));
  stateDir = await fs.realpath(created);
  queue = createQueue(stateDir);
  ingresses = [];
});

function createIngress(options: Partial<Parameters<typeof createIMessageDurableIngress>[0]> = {}) {
  const ingress = createIMessageDurableIngress({
    accountId: "default",
    queue,
    dispatch: vi.fn(),
    runtime: { error: vi.fn(), log: vi.fn() },
    ...options,
  });
  ingresses.push(ingress);
  return ingress;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const ingress of ingresses.toReversed()) {
    await ingress.stop();
  }
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("iMessage durable ingress", () => {
  it("does not advance the read cursor or dispatch when durable append fails", async () => {
    const appendError = new Error("sqlite unavailable");
    const failingQueue = {
      ...queue,
      enqueue: vi.fn().mockRejectedValue(appendError),
    } satisfies IMessageIngressQueue;
    const dispatch = vi.fn();
    const onDurableEnqueue = vi.fn();
    const onDurableEnqueueFailure = vi.fn();
    const ingress = createIngress({
      queue: failingQueue,
      dispatch,
      onDurableEnqueue,
      onDurableEnqueueFailure,
    });

    await expect(ingress.receive(rawRow())).rejects.toBe(appendError);
    expect(onDurableEnqueue).not.toHaveBeenCalled();
    expect(onDurableEnqueueFailure).toHaveBeenCalledWith(101, appendError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("notifies the source when inspection fails before durable append", async () => {
    const onDurableEnqueueFailure = vi.fn();
    const ingress = createIngress({ onDurableEnqueueFailure });

    await expect(ingress.receive(rawRow({ guid: undefined }))).rejects.toThrow(
      "missing its stable GUID",
    );
    expect(onDurableEnqueueFailure).toHaveBeenCalledWith(101, expect.any(Error));
    expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
  });

  it("serializes durable cursor advancement before admitting the next row", async () => {
    const cursorGate = deferred();
    const cursorStarted = deferred();
    let currentTime = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const onDurableEnqueue = vi.fn(async () => {
      cursorStarted.resolve();
      await cursorGate.promise;
    });
    const ingress = createIngress({ onDurableEnqueue });

    try {
      const first = ingress.receive(rawRow());
      await cursorStarted.promise;
      currentTime = 2_000;
      const second = ingress.receive(rawRow({ id: 102, guid: "GUID-102" }));
      await Promise.resolve();

      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "GUID-101",
      ]);
      currentTime = 9_000;
      cursorGate.resolve();
      await Promise.all([first, second]);
      expect(onDurableEnqueue).toHaveBeenCalledTimes(2);
      expect(
        (await queue.listPending({ limit: "all" })).map((record) => record.payload.receivedAt),
      ).toEqual([1_000, 2_000]);
    } finally {
      cursorGate.resolve();
      await ingress.stop();
    }
  });

  it("lets an approval poll vote overtake the conversation turn awaiting it", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const voteStarted = deferred();
    const dispatch = vi.fn(async (message: { id?: number | null }) => {
      if (message.id === 101) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else if (message.id === 102) {
        voteStarted.resolve();
      }
      return { kind: "completed" } as const;
    });
    const ingress = createIngress({
      dispatch,
      dispatchPriority: async (message) => {
        if (message.id !== 102) {
          return undefined;
        }
        voteStarted.resolve();
        return { kind: "completed" } as const;
      },
    });
    ingress.start();
    try {
      await ingress.receive(rawRow());
      await firstStarted.promise;
      await ingress.receive(
        rawRow({
          id: 102,
          guid: "GUID-102",
          poll: { kind: "vote", original_guid: "POLL-1", vote: { option_id: "deny" } },
        }),
      );
      await expect(
        Promise.race([
          voteStarted.promise.then(() => true),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 1_000);
          }),
        ]),
      ).resolves.toBe(true);
    } finally {
      releaseFirst.resolve();
      await ingress.stop();
    }
  });

  it("keeps an unowned poll vote behind the earlier conversation turn", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const unrelatedChecked = deferred();
    const dispatch = vi.fn(async (message: { id?: number | null }) => {
      if (message.id === 101) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { kind: "completed" } as const;
    });
    const ingress = createIngress({
      dispatch,
      dispatchPriority: async (message) => {
        if (message.id === 102) {
          unrelatedChecked.resolve();
        }
        return undefined;
      },
    });
    ingress.start();
    try {
      await ingress.receive(rawRow());
      await firstStarted.promise;
      await ingress.receive(
        rawRow({
          id: 102,
          guid: "GUID-102",
          poll: { kind: "vote", original_guid: "OTHER-POLL", vote: { option_id: "alpha" } },
        }),
      );
      await unrelatedChecked.promise;
      expect(dispatch.mock.calls.some(([message]) => message.id === 102)).toBe(false);

      releaseFirst.resolve();
      await ingress.waitForIdle();
      expect(dispatch.mock.calls.some(([message]) => message.id === 102)).toBe(true);
    } finally {
      releaseFirst.resolve();
      await ingress.stop();
    }
  });

  it("recovers a durable row with a fresh drain and dispatches exactly once", async () => {
    const event = rawRow();
    const interrupted = createIngress();
    await interrupted.receive(event);
    await interrupted.stop();

    closeOpenClawStateDatabaseForTest();
    const recoveredDispatch = vi.fn(async (_message, claimLifecycle) => {
      await claimLifecycle.onAdopted();
      return { kind: "deferred" } as const;
    });
    const recovered = createIngress({
      queue: createQueue(stateDir),
      dispatch: recoveredDispatch,
    });
    recovered.start();
    await recovered.waitForIdle();
    expect(recoveredDispatch).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.mock.calls[0]?.[0]).toMatchObject({
      id: 101,
      guid: "GUID-101",
      chat_id: 42,
    });
  });

  it("preserves the retired guard's GUID parity across ROWID churn", async () => {
    const dispatch = vi.fn(async (_message, claimLifecycle) => {
      await claimLifecycle.onAdopted();
      return { kind: "deferred" } as const;
    });
    const ingress = createIngress({ dispatch });
    ingress.start();
    await ingress.receive(rawRow());
    await ingress.waitForIdle();
    await ingress.receive(rawRow({ id: 999 }));
    await ingress.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("carries catchup provenance through the journal to dispatch", async () => {
    const provenances: Array<{ catchup?: boolean } | undefined> = [];
    const ingress = createIngress({
      dispatch: vi.fn(async (_message, claimLifecycle, _receivedAt, provenance) => {
        provenances.push(provenance);
        await claimLifecycle.onAdopted();
      }),
    });
    ingress.start();
    // Catchup bypasses the live Push age fence so old history is not tombstoned.
    await ingress.receive(rawRow({ guid: "GUID-CATCHUP", id: 900 }), { catchup: true });
    await ingress.receive(rawRow({ guid: "GUID-LIVE", id: 901 }));
    await vi.waitFor(() => expect(provenances).toHaveLength(2));
    expect(provenances).toEqual([{ catchup: true }, {}]);
  });

  it.each([
    ["GUID-bad", { guid: "GUID-bad", text: 123 }],
    ["GUID-missing", { guid: undefined }],
  ] as const)(
    "dead-letters malformed persisted payload %s without retry",
    async (id, overrides) => {
      await queue.enqueue(
        id,
        {
          version: 1,
          receivedAt: Date.now(),
          raw: rawRow(overrides),
        },
        { laneKey: "chat:42" },
      );
      const dispatch = vi.fn();
      const ingress = createIngress({ dispatch });
      ingress.start();
      await ingress.waitForIdle();
      expect((await queue.enqueue(id, {} as IMessageIngressPayload)).kind).toBe("failed");
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("dead-letters permanent Full Disk Access failures", async () => {
    const ingress = createIngress({
      dispatch: vi.fn(async () => {
        throw new Error("Full Disk Access denied for Messages chat.db");
      }),
    });
    ingress.start();
    await ingress.receive(rawRow());
    await ingress.waitForIdle();
    expect((await queue.enqueue("GUID-101", {} as IMessageIngressPayload)).kind).toBe("failed");
  });
});
