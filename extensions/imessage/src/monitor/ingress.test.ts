import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
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

async function expectDeadLetter(id: string) {
  expect((await queue.enqueue(id, {} as IMessageIngressPayload)).kind).toBe("failed");
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
    const cursorGate = deferred<void>();
    const cursorStarted = deferred<void>();
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

  it.each([true, false])(
    "only lets owned approval votes overtake a turn: owned=%s",
    async (owned) => {
      const firstStarted = deferred<void>();
      const releaseFirst = deferred<void>();
      const voteChecked = deferred<void>();
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
          if (message.id !== 102) {
            return undefined;
          }
          voteChecked.resolve();
          return owned ? ({ kind: "completed" } as const) : undefined;
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
            poll: {
              kind: "vote",
              original_guid: owned ? "POLL-1" : "OTHER-POLL",
              vote: { option_id: owned ? "deny" : "alpha" },
            },
          }),
        );
        await expect(
          Promise.race([
            voteChecked.promise.then(() => true),
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1_000);
            }),
          ]),
        ).resolves.toBe(true);
        expect(dispatch.mock.calls.some(([message]) => message.id === 102)).toBe(false);
        releaseFirst.resolve();
        await ingress.waitForIdle();
        expect(dispatch.mock.calls.some(([message]) => message.id === 102)).toBe(!owned);
      } finally {
        releaseFirst.resolve();
        await ingress.stop();
      }
    },
  );

  it("recovers provenance and dedupes durable GUIDs across ROWID churn", async () => {
    const event = rawRow();
    const interrupted = createIngress();
    await interrupted.receive(event, { catchup: true });
    await interrupted.stop();

    closeOpenClawStateDatabaseForTest();
    const provenances: Array<{ catchup?: boolean } | undefined> = [];
    const recoveredDispatch = vi.fn<Parameters<typeof createIMessageDurableIngress>[0]["dispatch"]>(
      async (_message, claimLifecycle, _receivedAt, provenance) => {
        provenances.push(provenance);
        await claimLifecycle.onAdopted();
        return { kind: "deferred" } as const;
      },
    );
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
    await recovered.receive(rawRow({ id: 999 }));
    await recovered.waitForIdle();
    expect(recoveredDispatch).toHaveBeenCalledTimes(1);
    await recovered.receive(rawRow({ guid: "GUID-LIVE", id: 901 }));
    await recovered.waitForIdle();
    expect(provenances).toEqual([{ catchup: true }, {}]);
  });

  it.each([
    ["GUID-bad", { guid: "GUID-bad", text: 123 }, false],
    ["GUID-missing", { guid: undefined }, false],
    ["GUID-101", {}, true],
  ] as const)("dead-letters permanent failure %s", async (id, overrides, denied) => {
    const dispatch = vi.fn(async () => {
      if (denied) {
        throw new Error("Full Disk Access denied for Messages chat.db");
      }
    });
    const ingress = createIngress({ dispatch });
    if (denied) {
      await ingress.receive(rawRow());
    } else {
      await queue.enqueue(
        id,
        { version: 1, receivedAt: Date.now(), raw: rawRow(overrides) },
        { laneKey: "chat:42" },
      );
    }
    ingress.start();
    await ingress.waitForIdle();
    await expectDeadLetter(id);
    if (!denied) {
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});
