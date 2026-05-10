import { describe, expect, it } from "vitest";
import { SessionActorQueue } from "./session-actor-queue.js";

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

async function runWithAbortBeforeStart<T>(params: {
  queue: SessionActorQueue;
  actorKey: string;
  op: () => Promise<T>;
  signal: AbortSignal;
}): Promise<T> {
  let actorStarted = false;
  const queued = params.queue.run(params.actorKey, async () => {
    actorStarted = true;
    if (params.signal.aborted) {
      throw new Error("aborted");
    }
    return await params.op();
  });

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (actorStarted) {
        return;
      }
      params.queue.markAbortBeforeStart(params.actorKey);
      reject(new Error("aborted before start"));
    };
    params.signal.addEventListener("abort", onAbort, { once: true });
    queued.then(resolve, reject);
    if (params.signal.aborted) {
      onAbort();
    }
  });
}

describe("SessionActorQueue diagnostics", () => {
  it("reports previous tail and pending state for an abort-before-start queued actor", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "agent:main:explicit:koura-recruiting-test-001";
    const firstGate = deferred<void>();
    const firstRun = queue.run(actorKey, async () => {
      await firstGate.promise;
    });
    await flushMicrotasks();

    const controller = new AbortController();
    const secondRun = runWithAbortBeforeStart({
      queue,
      actorKey,
      signal: controller.signal,
      op: async () => undefined,
    });
    await flushMicrotasks();
    controller.abort();

    await expect(secondRun).rejects.toThrow("aborted before start");
    expect(queue.getPendingCountForSession(actorKey)).toBe(2);
    expect(queue.getTailMapForTesting().has(actorKey)).toBe(true);
    expect(queue.getDiagnosticSnapshot(actorKey)).toMatchObject({
      actorKey,
      actorStarted: false,
      abortBeforeStart: true,
      pendingCount: 2,
      previousTailPresent: true,
      settleTime: null,
    });

    firstGate.resolve();
    await firstRun;
    await flushMicrotasks();
  });
});

describe("SessionActorQueue cancellable queued item via signal", () => {
  it("does not call op() when signal aborts before the actor starts", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-no-op";
    const firstGate = deferred<void>();
    const firstRun = queue.run(actorKey, async () => {
      await firstGate.promise;
    });
    await flushMicrotasks();

    const controller = new AbortController();
    let opCalled = false;
    const secondRun = queue.run(
      actorKey,
      async () => {
        opCalled = true;
        return "second-result";
      },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort();

    // Predecessor settles, allowing the cancelled item to reach the head of the queue.
    firstGate.resolve();
    await firstRun;
    await flushMicrotasks();

    await expect(secondRun).rejects.toMatchObject({ name: "AbortError" });
    expect(opCalled).toBe(false);
  });

  it("decrements pending immediately on abort-before-start", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-early-decrement";
    const firstGate = deferred<void>();
    const firstRun = queue.run(actorKey, async () => {
      await firstGate.promise;
    });
    await flushMicrotasks();
    expect(queue.getPendingCountForSession(actorKey)).toBe(1);

    const controller = new AbortController();
    const secondRun = queue.run(actorKey, async () => "should-not-run", {
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(queue.getPendingCountForSession(actorKey)).toBe(2);

    controller.abort();
    await flushMicrotasks();
    // Cancelled item is logically gone even though its slot still occupies the chain.
    expect(queue.getPendingCountForSession(actorKey)).toBe(1);

    firstGate.resolve();
    await firstRun;
    await expect(secondRun).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    // Both items have settled; pending must not go negative or double-decrement.
    expect(queue.getPendingCountForSession(actorKey)).toBe(0);
  });

  it("decrements pending only once across cancel and onSettle", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-decrement-once";
    const controller = new AbortController();
    const cancelled = queue.run(actorKey, async () => "never", { signal: controller.signal });
    expect(queue.getPendingCountForSession(actorKey)).toBe(1);

    controller.abort();
    await flushMicrotasks();
    // Cancellation decrement (early) lands; the queue chain still settles the
    // wrapped task asynchronously, but pending must remain at 0, not -1.
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(queue.getPendingCountForSession(actorKey)).toBe(0);
  });

  it("preserves per-key serialization for cancelled items (third does not jump ahead)", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-serialization";
    const firstGate = deferred<void>();

    const firstRun = queue.run(actorKey, async () => {
      await firstGate.promise;
      return "first";
    });
    await flushMicrotasks();

    const controller = new AbortController();
    const cancelled = queue.run(actorKey, async () => "second", { signal: controller.signal });
    await flushMicrotasks();

    let thirdStarted = false;
    const thirdRun = queue.run(actorKey, async () => {
      thirdStarted = true;
      return "third";
    });
    await flushMicrotasks();

    controller.abort();
    await flushMicrotasks();
    // Even though item 2 is cancelled, item 3 must wait until item 1 settles.
    expect(thirdStarted).toBe(false);

    firstGate.resolve();
    await firstRun;
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await thirdRun;
    expect(thirdStarted).toBe(true);
  });

  it("rejects immediately when run() is called with an already-aborted signal", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-pre-aborted";
    const controller = new AbortController();
    controller.abort();

    let opCalled = false;
    const result = queue.run(
      actorKey,
      async () => {
        opCalled = true;
        return "noop";
      },
      { signal: controller.signal },
    );

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(opCalled).toBe(false);
    expect(queue.getPendingCountForSession(actorKey)).toBe(0);
  });

  it("keeps the queue alive after a cancelled item — subsequent tasks still run", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-keeps-alive";
    const controller = new AbortController();
    controller.abort();
    const cancelled = queue.run(actorKey, async () => "noop", { signal: controller.signal });
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();

    const followup = await queue.run(actorKey, async () => "followup-result");
    expect(followup).toBe("followup-result");
    expect(queue.getPendingCountForSession(actorKey)).toBe(0);
  });

  it("backward-compatible: run() without signal behaves identically to before", async () => {
    const queue = new SessionActorQueue();
    const actorKey = "test-actor-backward-compat";
    const result = await queue.run(actorKey, async () => "ok");
    expect(result).toBe("ok");
    expect(queue.getPendingCountForSession(actorKey)).toBe(0);
  });
});
