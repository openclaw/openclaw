// Real ingress monitor and SQLite queue, with clocks and transport delivery controlled.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

type Queue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type Payload = Parameters<Queue["enqueue"]>[1];
const now = 1_800_000_000_000;
function event(timestamp = now - 1_000, uuid?: string): SignalSseEvent {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        ...(uuid ? { sourceUuid: uuid } : {}),
        timestamp,
        dataMessage: { timestamp, message: "synthetic-private-message" },
      },
    }),
  };
}
function timingRows(log: ReturnType<typeof vi.fn>): unknown[] {
  return log.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith('{"signalIngressTiming":true,')) {
      return [];
    }
    return [JSON.parse(line)];
  });
}
async function withQueue(run: (queue: Queue) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-timing-"));
  const queue = createChannelIngressQueueForTests<Payload>({
    channelId: "signal",
    accountId: "default",
    stateDir: dir,
  });
  try {
    await run(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function open(queue: Queue, log = vi.fn()) {
  const dispatch = vi.fn(async () => undefined);
  const monitor = await startSignalIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { log, error: vi.fn() },
  });
  return { monitor, log, dispatch };
}
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Signal admission timing", () => {
  it("does not invent a fresh admission timing for recovered durable rows", async () => {
    await withQueue(async (queue) => {
      const input = event();
      await queue.enqueue(
        JSON.stringify(["number:+15550001111", now - 1_000]),
        { version: 1, receivedAt: now, event: input },
        { receivedAt: now, laneKey: "direct:number:+15550001111" },
      );
      const f = await open(queue);
      try {
        await f.monitor.waitForIdle();
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(timingRows(f.log)).toEqual([]);
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it.each([
    { age: 240_000, elapsed: 5, seconds: 240 },
    { age: 1_000, elapsed: 239_000, seconds: 1 },
    { age: -2_500, elapsed: 3, seconds: -2 },
  ])(
    "distinguishes signed envelope age $age from local admission $elapsed",
    async ({ age, elapsed, seconds }) => {
      await withQueue(async (queue) => {
        let monotonic = 0;
        vi.spyOn(Date, "now").mockReturnValue(now);
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const enqueue = queue.enqueue.bind(queue);
        vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
          const result = await enqueue(...args);
          monotonic = elapsed;
          return result;
        });
        const f = await open(queue);
        try {
          await f.monitor.receive(event(now - age));
          expect(timingRows(f.log)).toEqual([
            {
              signalIngressTiming: true,
              envelopeAgeAtIngressSeconds: seconds,
              localAdmissionElapsedMs: elapsed,
            },
          ]);
          expect(f.dispatch).toHaveBeenCalledOnce();
        } finally {
          await f.monitor.stop();
        }
      });
    },
  );

  it("does not persist timing facts in the durable event payload", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.spyOn(queue, "enqueue");
      const f = await open(queue);
      const input = event();
      try {
        await f.monitor.receive(input);
        expect(enqueue.mock.calls[0]?.[1]).toEqual({
          version: 1,
          receivedAt: expect.any(Number),
          event: input,
        });
        expect(timingRows(f.log)).toHaveLength(1);
        expect(Object.keys(timingRows(f.log)[0] as object).toSorted()).toEqual([
          "envelopeAgeAtIngressSeconds",
          "localAdmissionElapsedMs",
          "signalIngressTiming",
        ]);
        expect(JSON.stringify(timingRows(f.log))).not.toContain("synthetic-private-message");
        expect(JSON.stringify(timingRows(f.log))).not.toContain("15550001111");
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("suppresses concrete and identity-alias duplicate timing records", async () => {
    await withQueue(async (queue) => {
      const f = await open(queue);
      try {
        await f.monitor.receive(event());
        await f.monitor.receive(event());
        await f.monitor.receive(event(now - 1_000, "123e4567-e89b-12d3-a456-426614174000"));
        expect(timingRows(f.log)).toHaveLength(1);
        expect(f.dispatch).toHaveBeenCalledOnce();
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("includes identity-alias work but excludes dispatch waiting", async () => {
    await withQueue(async (queue) => {
      let monotonic = 10;
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const complete = queue.complete.bind(queue);
      vi.spyOn(queue, "complete").mockImplementation(async (...args) => {
        const result = await complete(...args);
        monotonic = 30;
        return result;
      });
      const log = vi.fn();
      const monitor = await startSignalIngressMonitor({
        accountId: "default",
        queue,
        runtime: { log, error: vi.fn() },
        dispatch: async () => {
          monotonic = 9_000;
        },
      });
      try {
        await monitor.receive(event(now - 1_000, "123e4567-e89b-12d3-a456-426614174000"));
        expect(timingRows(log)).toEqual([expect.objectContaining({ localAdmissionElapsedMs: 20 })]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps local admission duration independent of wall-clock changes", async () => {
    await withQueue(async (queue) => {
      let wall = now;
      let monotonic = 0;
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const enqueue = queue.enqueue.bind(queue);
      vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
        const result = await enqueue(...args);
        wall += 3_600_000;
        monotonic = 7;
        return result;
      });
      const f = await open(queue);
      try {
        await f.monitor.receive(event(now - 1_000));
        expect(timingRows(f.log)).toEqual([
          { signalIngressTiming: true, envelopeAgeAtIngressSeconds: 1, localAdmissionElapsedMs: 7 },
        ]);
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("includes waiting behind another serialized admission", async () => {
    await withQueue(async (queue) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let monotonic = 0;
      let calls = 0;
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const enqueue = queue.enqueue.bind(queue);
      vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return await enqueue(...args);
      });
      const f = await open(queue);
      const first = f.monitor.receive(event(now - 2_000));
      let second: Promise<void> | undefined;
      try {
        await entered.promise;
        monotonic = 10;
        second = f.monitor.receive(event(now - 1_000));
        monotonic = 90;
        release.resolve();
        await Promise.all([first, second]);
        expect(timingRows(f.log)).toEqual([
          expect.objectContaining({ localAdmissionElapsedMs: 90 }),
          expect.objectContaining({ localAdmissionElapsedMs: 80 }),
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await f.monitor.stop();
      }
    });
  });

  it("isolates a throwing timing logger from admission and delivery", async () => {
    await withQueue(async (queue) => {
      const log = vi.fn((line: string) => {
        if (line.startsWith('{"signalIngressTiming":true,')) {
          throw new Error("logger unavailable");
        }
      });
      const f = await open(queue, log);
      try {
        await expect(f.monitor.receive(event())).resolves.toBeUndefined();
        expect(timingRows(f.log)).toHaveLength(1);
        expect(f.dispatch).toHaveBeenCalledOnce();
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("does not report successful admission when enqueue fails", async () => {
    await withQueue(async (queue) => {
      const failure = new Error("storage unavailable");
      vi.spyOn(queue, "enqueue").mockRejectedValue(failure);
      const f = await open(queue);
      try {
        await expect(f.monitor.receive(event())).rejects.toBe(failure);
        expect(timingRows(f.log)).toEqual([]);
        expect(f.dispatch).not.toHaveBeenCalled();
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("does not report successful timing when identity-alias handling fails", async () => {
    await withQueue(async (queue) => {
      const failure = new Error("alias storage unavailable");
      const aliasId = JSON.stringify(["number:+15550001111", now - 1_000]);
      const complete = queue.complete.bind(queue);
      vi.spyOn(queue, "complete").mockImplementation(async (...args) => {
        if (args[0] === aliasId) {
          throw failure;
        }
        return await complete(...args);
      });
      const f = await open(queue);
      try {
        await expect(
          f.monitor.receive(event(now - 1_000, "123e4567-e89b-12d3-a456-426614174000")),
        ).rejects.toBe(failure);
        expect(timingRows(f.log)).toEqual([]);
        // The existing monitor owns recovery of an already-durable row after callback failure.
        // This diagnostic change must not claim that such a row was never admitted or dispatched.
      } finally {
        await f.monitor.stop();
      }
    });
  });

  it("does not log timing for ignored transport-only envelopes", async () => {
    await withQueue(async (queue) => {
      const f = await open(queue);
      try {
        await f.monitor.receive({
          event: "receive",
          data: JSON.stringify({
            envelope: { timestamp: now, sourceNumber: "+15550001111", typingMessage: {} },
          }),
        });
        expect(timingRows(f.log)).toEqual([]);
        expect(f.dispatch).not.toHaveBeenCalled();
      } finally {
        await f.monitor.stop();
      }
    });
  });
});
