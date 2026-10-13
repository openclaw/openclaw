import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { bindingStoreKey, createCodexAppServerBindingStore } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import {
  getOrCreateSharedClientEntry,
  getSharedCodexAppServerClientState,
  retainSharedClientEntry,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client-lifecycle.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership-queue.js";

function createHandoffFixture(label: string) {
  const old = createClientHarness({ autoEmitExit: false });
  const successor = createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number };
      send({ id: request.id, result: {} });
    },
  });
  const shared = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(shared, `handoff-cancellation:${label}`);
  entry.client = old.client;
  shared.liveClients.add(old.client);
  shared.entriesByClient.set(old.client, entry);
  const releaseOriginalLease = retainSharedClientEntry(entry);
  const rawBindings = createCodexTestBindingStateStore();
  const bindings = createCodexAppServerBindingStore(rawBindings);
  const identity = { kind: "session" as const, agentId: "main", sessionId: label };
  const threadId = `handoff-cancellation:${label}`;
  const handoff = (signal?: AbortSignal) =>
    releaseCodexBoundLiveThread({
      client: successor.client,
      clientId: successor.client.getInstanceId(),
      ownerClientId: old.client.getInstanceId(),
      threadId,
      lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
      signal,
    });
  return {
    old,
    successor,
    shared,
    entry,
    bindings,
    threadId,
    identity,
    handoff,
    bindingLease: () => rawBindings.lookup(bindingStoreKey(identity))?.lease,
    cleanup: () => {
      releaseOriginalLease();
      old.client.close();
      old.emitExit();
      successor.client.close();
      successor.emitExit();
      shared.liveClients.delete(old.client);
      shared.entriesByClient.delete(old.client);
      if (shared.clients.get(entry.key) === entry) {
        shared.clients.delete(entry.key);
      }
    },
  };
}

it.each(["closed", "force-retired"] as const)(
  "cancels a %s owner handoff and admits a successor without releasing the physical writer fence",
  async (state) => {
    const fixture = createHandoffFixture(state);
    if (state === "closed") {
      fixture.old.client.close();
    } else {
      retireSharedCodexAppServerClientIfCurrent(fixture.old.client, { failActiveLeases: true });
    }
    const controller = new AbortController();
    const reason = new Error("startup deadline");
    let firstOutcome: unknown = "pending";
    let successorEntered = false;
    const first = withCodexAppServerThreadMutation(fixture.threadId, () =>
      fixture.bindings.withLease(
        fixture.identity,
        async () => {
          await fixture.handoff(controller.signal);
          controller.signal.throwIfAborted();
          await fixture.successor.client.request("thread/resume", { threadId: "obsolete-writer" });
        },
        { assertCurrent: () => controller.signal.throwIfAborted() },
      ),
    );
    void first.then(
      () => {
        firstOutcome = "resolved";
      },
      (error: unknown) => {
        firstOutcome = error;
      },
    );
    const next = withCodexAppServerThreadMutation(fixture.threadId, () =>
      fixture.bindings.withLease(fixture.identity, async () => {
        successorEntered = true;
        await fixture.handoff();
        await fixture.successor.client.request("thread/resume", { threadId: fixture.threadId });
        expect(fixture.old.process.exitCode).toBe(0);
      }),
    );
    // Observe rejection immediately, even if an assertion fails before cleanup joins it.
    void next.catch(() => {});
    try {
      await setImmediate();
      const firstLeaseToken = fixture.bindingLease()?.token;
      expect(firstLeaseToken).toBeDefined();
      expect(firstOutcome).toBe("pending");
      expect(successorEntered).toBe(false);
      controller.abort(reason);
      await setImmediate();

      expect(firstOutcome).toBe(reason);
      expect(successorEntered).toBe(true);
      // The admitted successor owns a different binding lease and waits independently.
      expect(fixture.bindingLease()?.token).toBeDefined();
      expect(fixture.bindingLease()?.token).not.toBe(firstLeaseToken);
      expect(fixture.entry.activeLeases).toBe(1);
      expect(fixture.shared.liveClients.has(fixture.old.client)).toBe(true);
      expect(fixture.shared.entriesByClient.get(fixture.old.client)).toBe(fixture.entry);
      expect(fixture.old.process.exitCode).toBeNull();
      expect(fixture.successor.writes).toEqual([]);

      fixture.old.emitExit();
      await expect(first).rejects.toBe(reason);
      await next;
      expect(fixture.successor.writes.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({
          method: "thread/resume",
          params: { threadId: fixture.threadId },
        }),
      ]);
      expect(fixture.bindingLease()).toBeUndefined();
    } finally {
      // Genuine exit also drains the unfixed baseline; never clear an active queue tail.
      fixture.old.emitExit();
      await Promise.allSettled([first, next]);
      fixture.cleanup();
    }
  },
);

it("rejects a pre-aborted closed-owner handoff without retaining a client lease", async () => {
  const fixture = createHandoffFixture("pre-aborted-closed");
  retireSharedCodexAppServerClientIfCurrent(fixture.old.client, { failActiveLeases: true });
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  let outcome: unknown = "pending";
  const handoff = fixture.handoff(controller.signal);
  void handoff.then(
    () => {
      outcome = "resolved";
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    await setImmediate();
    expect(outcome).toBe(reason);
    expect(fixture.entry.activeLeases).toBe(1);
    expect(fixture.old.process.exitCode).toBeNull();
    expect(fixture.successor.writes).toEqual([]);
  } finally {
    fixture.old.emitExit();
    await Promise.allSettled([handoff]);
    fixture.cleanup();
  }
});

it.each(["before", "during"] as const)(
  "releases a usable retired-owner retain when cancellation arrives %s acquisition",
  async (when) => {
    const fixture = createHandoffFixture(`usable-retired-${when}`);
    retireSharedCodexAppServerClientIfCurrent(fixture.old.client);
    const controller = new AbortController();
    const reason = new Error("cancelled handoff");
    if (when === "before") {
      controller.abort(reason);
    }
    const handoff = fixture.handoff(controller.signal);
    try {
      if (when === "during") {
        // The async retain has acquired its lease synchronously, before delivering it.
        expect(fixture.entry.activeLeases).toBe(2);
        controller.abort(reason);
      }
      await expect(handoff).rejects.toBe(reason);
      expect(fixture.entry.activeLeases).toBe(1);
      expect(fixture.old.client.getCloseError()).toBeUndefined();
      expect(fixture.old.process.exitCode).toBeNull();
      expect(fixture.successor.writes).toEqual([]);
    } finally {
      fixture.old.emitExit();
      await Promise.allSettled([handoff]);
      fixture.cleanup();
    }
  },
);
