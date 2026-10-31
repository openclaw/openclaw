import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionActorQueue } from "./session-actor-queue.js";

describe("SessionActorQueue timeout retirement", () => {
  it("admits fresh work while counting stuck and queued retired work until settlement", async () => {
    const queue = new SessionActorQueue();
    const started = createDeferred();
    const release = createDeferred();
    let oldIsCurrent: (() => boolean) | undefined;
    const old = queue.run("main/session", async (isCurrent) => {
      oldIsCurrent = isCurrent;
      started.resolve();
      await release.promise;
    });
    await started.promise;
    let staleQueuedRan = false;
    const queued = queue.run("main/session", async () => {
      staleQueuedRan = true;
    });
    const rejectedQueued = expect(queued).rejects.toThrow("superseded");
    expect(queue.getTotalPendingCount()).toBe(2);
    queue.rotate("main/session");
    expect(oldIsCurrent?.()).toBe(false);
    await queue.run("main/session", async (isCurrent) => {
      expect(isCurrent()).toBe(true);
    });
    expect(queue.getTotalPendingCount()).toBe(2);
    release.resolve();
    await old;
    await rejectedQueued;
    expect(staleQueuedRan).toBe(false);
    expect(queue.getTotalPendingCount()).toBe(0);
  });

  it("does not retire another owner's lane or a successor through a released capture", async () => {
    const queue = new SessionActorQueue();
    const old = queue.capture("main/session");
    const other = queue.capture("work/session");
    queue.rotate("main/session");
    const next = queue.capture("main/session");
    old.release();
    expect(old.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
    expect(other.isCurrent()).toBe(true);
    next.release();
    other.release();
  });
});
