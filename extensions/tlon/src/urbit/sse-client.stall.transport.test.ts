// Offline loopback composition, not a live Tlon or Gateway/model proof.
import { createServer, type ServerResponse } from "node:http";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const cleanups: Array<() => Promise<void>> = [];

async function openFixture(signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0], signal });
  const streams: ServerResponse[] = [];
  const closed: number[] = [];
  const paths: string[] = [];
  const retryScheduled = Promise.withResolvers<void>();
  const delivered: unknown[] = [];
  const onReconnect = vi.fn();
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      paths.push(request.url ?? "");
      const index = streams.length;
      streams.push(response);
      closed.push(0);
      response.once("close", () => {
        closed[index] = (closed[index] ?? 0) + 1;
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      if (index > 0) {
        response.write('data: {"id":1,"json":{"message":"reconnected"}}\n\n');
      }
      return;
    }
    request.resume();
    request.once("end", () => response.writeHead(204).end());
  });
  const client = new UrbitSSEClient(
    `http://127.0.0.1:${claim.port}`,
    "urbauth-~zod=synthetic-stall-proof",
    {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      onReconnect,
      logger: {
        log: (message) => {
          if (message.includes("in 1000ms")) {
            retryScheduled.resolve();
          }
        },
      },
    },
  );
  const processing = vi.spyOn(client, "processStream");
  cleanups.push(async () => {
    client.stopReceiving();
    await client.close();
    await Promise.allSettled(processing.mock.results.map((result) => result.value));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await claim.release();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(claim.port, "127.0.0.1", resolve);
  });
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clearInterval = vi.spyOn(globalThis, "clearInterval");
  let receive: (payload: unknown) => Promise<void> | void = (payload) => {
    delivered.push(payload);
  };
  await client.subscribe({ app: "chat", path: "/inbox", event: (payload) => receive(payload) });
  await client.connect();
  const originalController = client.streamController;
  if (!originalController) {
    throw new Error("Expected a connected SSE controller");
  }
  return {
    client,
    closed,
    paths,
    delivered,
    onReconnect,
    originalController,
    send(text: string) {
      const stream = streams[0];
      if (!stream) {
        throw new Error("Expected the initial HTTP stream");
      }
      stream.write(text);
    },
    retryScheduled: retryScheduled.promise,
    receive: (handler: typeof receive) => {
      receive = handler;
    },
    assertTimersCleared() {
      const handles = intervals.mock.results
        .filter((_result, index) => intervals.mock.calls[index]?.[1] === 5_000)
        .map((result) => result.value);
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) {
        expect(clearInterval.mock.calls.filter(([value]) => value === handle)).toHaveLength(1);
      }
    },
  };
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("UrbitSSEClient silent stream recovery over loopback HTTP", () => {
  it("aborts a silent connected stream and delivers again on the same channel", async ({
    signal,
  }) => {
    const proof = await openFixture(signal);
    const resumed = Promise.withResolvers<void>();
    proof.receive((payload) => {
      proof.delivered.push(payload);
      resumed.resolve();
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(proof.originalController.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Red must occur here on the unmodified production owner, not a fixture timeout.
    expect(proof.originalController.signal.aborted).toBe(true);
    await withinTest(proof.retryScheduled, signal);
    expect(proof.onReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await withinTest(resumed.promise, signal);
    expect(proof.delivered).toEqual([{ message: "reconnected" }]);
    expect(proof.paths).toEqual([
      `/~/channel/${proof.client.channelId}`,
      `/~/channel/${proof.client.channelId}`,
    ]);
    expect(proof.onReconnect).toHaveBeenCalledOnce();
    await proof.client.close();
    expect(proof.closed[0]).toBe(1);
    proof.assertTimersCleared();
  });

  it("excludes awaited handlers from idle time and rearms after delivery", async ({ signal }) => {
    const proof = await openFixture(signal);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const next = Promise.withResolvers<void>();
    proof.receive(async (payload) => {
      proof.delivered.push(payload);
      if (proof.delivered.length === 1) {
        started.resolve();
        await release.promise;
      } else {
        next.resolve();
      }
    });
    try {
      proof.send(
        'data: {"id":1,"json":{"message":"slow"}}\n\ndata: {"id":1,"json":{"message":"next"}}\n\n',
      );
      await withinTest(started.promise, signal);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(proof.originalController.signal.aborted).toBe(false);
      expect(proof.onReconnect).not.toHaveBeenCalled();
      expect(proof.delivered).toEqual([{ message: "slow" }]);
      release.resolve();
      await withinTest(next.promise, signal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(proof.originalController.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(proof.originalController.signal.aborted).toBe(true);
      await withinTest(proof.retryScheduled, signal);
      proof.client.stopReceiving();
    } finally {
      release.resolve();
    }
  });

  it("keeps receiving chunks and clears the watchdog on stop", async ({ signal }) => {
    const proof = await openFixture(signal);
    for (let beat = 0; beat < 4; beat += 1) {
      const received = Promise.withResolvers<void>();
      proof.receive(() => received.resolve());
      await vi.advanceTimersByTimeAsync(20_000);
      proof.send(': heartbeat\n\ndata: {"id":1,"json":{"beat":true}}\n\n');
      await withinTest(received.promise, signal);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(proof.originalController.signal.aborted).toBe(false);
    proof.client.stopReceiving();
    await proof.client.close();
    proof.assertTimersCleared();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(proof.onReconnect).not.toHaveBeenCalled();
    expect(proof.paths).toHaveLength(1);
  });

  it("stops the timer immediately while a handler is still awaited", async ({ signal }) => {
    const proof = await openFixture(signal);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    proof.receive(async () => {
      started.resolve();
      await release.promise;
    });
    try {
      proof.send('data: {"id":1,"json":{"message":"held"}}\n\n');
      await withinTest(started.promise, signal);
      proof.client.stopReceiving();
      proof.assertTimersCleared();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(proof.onReconnect).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await proof.client.close();
    expect(proof.paths).toHaveLength(1);
  });
});
