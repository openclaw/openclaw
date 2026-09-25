/** Tests exec-completion steering queue enqueue, leasing, ack/release, ownership, and shared occurrence. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  drainSystemEventEntries,
  enqueueSystemEventEntry,
  enqueueSystemEventReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  ackLeasedExecSteeringItems,
  ensureExecSteeringConsumptionObserver,
  enqueueExecSteeringCompletion,
  hasPendingExecSteeringItems,
  holdExecSteeringForDelivery,
  invalidateExecSteeringByDurableEventId,
  leasePendingExecSteeringItems,
  prependExecSteeringPrompt,
  releaseLeasedExecSteeringItems,
  resetExecSteeringQueueForTest,
  retireExecSteeringForSessionKeys,
} from "./exec-steering-queue.js";

const requesterSessionKey = "agent:main:main";

function enqueue(
  overrides: {
    execId?: string;
    status?: string;
    exitLabel?: string;
    text?: string;
    endedAt?: number;
    requesterSessionKey?: string;
    ownerAgentId?: string;
    occurrenceKey?: string;
    durableEventId?: string;
  } = {},
): string {
  const itemId = enqueueExecSteeringCompletion({
    requesterSessionKey: overrides.requesterSessionKey ?? requesterSessionKey,
    ...(overrides.ownerAgentId ? { ownerAgentId: overrides.ownerAgentId } : {}),
    occurrenceKey: overrides.occurrenceKey ?? `exec:${overrides.execId ?? "abcd1234"}`,
    ...(overrides.durableEventId ? { durableEventId: overrides.durableEventId } : {}),
    execId: overrides.execId ?? "abcd1234",
    status: overrides.status ?? "completed",
    exitLabel: overrides.exitLabel ?? "exit 0",
    text: overrides.text ?? "job done",
    endedAt: overrides.endedAt ?? 1_000,
  });
  if (!itemId) {
    throw new Error("expected an enqueued item id");
  }
  return itemId;
}

/**
 * Enqueues a durable system event and a steering copy that shares its
 * globally-unique id, mirroring the exec-runtime notification path so
 * settlement can be exercised through the real consumption observer.
 */
function enqueueSharedOccurrence(overrides: {
  execId: string;
  requesterSessionKey?: string;
  ownerAgentId?: string;
  text?: string;
}): {
  durableEventId: string;
  queueKey: string;
  occurrenceKey: string;
  remove: () => boolean;
} {
  const sessionKey = overrides.requesterSessionKey ?? requesterSessionKey;
  const occurrenceKey = `exec:${overrides.execId}`;
  const receipt = enqueueSystemEventReceipt(
    `Exec completed (${overrides.execId}, exit 0) :: ${overrides.text ?? "job done"}`,
    {
      sessionKey,
      contextKey: occurrenceKey,
    },
    { allowDuplicate: true },
  );
  if (!receipt) {
    throw new Error("expected a durable system event receipt");
  }
  enqueue({
    execId: overrides.execId,
    occurrenceKey,
    durableEventId: receipt.eventId,
    text: overrides.text,
    ...(overrides.requesterSessionKey
      ? { requesterSessionKey: overrides.requesterSessionKey }
      : {}),
    ...(overrides.ownerAgentId ? { ownerAgentId: overrides.ownerAgentId } : {}),
  });
  return {
    durableEventId: receipt.eventId,
    queueKey: sessionKey,
    occurrenceKey,
    remove: receipt.remove,
  };
}

describe("exec-steering-queue", () => {
  beforeEach(() => {
    resetExecSteeringQueueForTest();
  });
  afterEach(() => {
    resetSystemEventsForTest();
    // The store resolver is process-global, so a case that publishes one clears
    // it here rather than resolving the next case against a stale path.
    publishSystemEventStoreResolver(undefined);
  });

  it("leases a pending completion into a turn prompt", () => {
    enqueue({ text: "compilation finished" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    expect(leased?.itemIds).toHaveLength(1);
    expect(leased?.prompt).toContain("Background exec completions arrived");
    expect(leased?.prompt).toContain("compilation finished");
    expect(leased?.isCurrent()).toBe(true);
    // Once leased, it is no longer offered to a concurrent lease.
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
  });

  it("returns nothing for an idle session with no completions", () => {
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
  });

  it("targets completions to the requester session key", () => {
    enqueue({ requesterSessionKey: "agent:main:other", text: "other session" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey: "agent:main:other",
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
  });

  it("cannot leak one agent's global completion to another agent (cross-agent isolation)", () => {
    // Two agents both use the literal session key "global". The completion is
    // owned by the research agent; the main agent must never lease it.
    enqueue({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      execId: "research1",
      text: "research secret output",
    });
    // The main agent, sharing the literal "global" key, resolves a distinct
    // agent-qualified queue key and sees nothing.
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "global", ownerAgentId: "main" }),
    ).toBe(false);
    expect(
      leasePendingExecSteeringItems({
        requesterSessionKey: "global",
        ownerAgentId: "main",
        leaseId: "run-main:exec-steering",
      }),
    ).toBeUndefined();
    // The owning research agent leases its own output.
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      leaseId: "run-research:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
    expect(leased?.prompt).toContain("research secret output");
  });

  it("refuses an owner that contradicts the session key instead of using an unqualified key", () => {
    // Pairing agent:main:main with the research owner cannot be qualified, so
    // the completion is dropped rather than stored under a shared literal key.
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey: "agent:main:main",
        ownerAgentId: "research",
        occurrenceKey: "exec:conflict1",
        execId: "conflict1",
        status: "completed",
        exitLabel: "exit 0",
        text: "unqualifiable",
      }),
    ).toBeUndefined();
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "agent:main:main", ownerAgentId: "main" }),
    ).toBe(false);
  });

  it("preserves another agent's completions during an agent-scoped reset", () => {
    enqueue({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      occurrenceKey: "exec:keep0001",
      execId: "keep0001",
      text: "research work",
    });

    expect(
      retireExecSteeringForSessionKeys({
        requesterSessionKeys: ["agent:research:global"],
        ownerAgentId: "main",
      }),
    ).toBe(0);
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "global", ownerAgentId: "research" }),
    ).toBe(true);
  });

  it("acks a leased item so it is delivered exactly once", () => {
    enqueue();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const acked = ackLeasedExecSteeringItems({
      itemIds: leased!.itemIds,
      leaseId: "run-1:exec-steering",
    });
    expect(acked).toBe(1);
    // A second ack is a no-op; the item is gone.
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-1:exec-steering" }),
    ).toBe(0);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("acking a steered turn retires the shared durable system event (steering -> heartbeat)", () => {
    const queueKey = "agent:main:main";
    // The durable system event the notify path enqueues for this occurrence.
    const receipt = enqueueSystemEventReceipt(
      "Exec completed (abcd1234, exit 0) :: job done",
      { sessionKey: queueKey, contextKey: "exec:abcd1234" },
      { allowDuplicate: true },
    );
    if (!receipt) {
      throw new Error("expected a durable system event receipt");
    }
    expect(peekSystemEventEntries(queueKey)).toHaveLength(1);

    // The steering copy the notify path enqueues for the same occurrence, bound
    // to the durable event's globally-unique id.
    enqueue({
      occurrenceKey: "exec:abcd1234",
      execId: "abcd1234",
      durableEventId: receipt.eventId,
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-1:exec-steering" });

    // A later heartbeat must find nothing to deliver: exactly-once across paths.
    expect(peekSystemEventEntries(queueKey)).toEqual([]);
  });

  it("settles the steering copy when its durable event is consumed elsewhere", () => {
    const shared = enqueueSharedOccurrence({ execId: "zzz99999", text: "polled output" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
    // A terminal poll or heartbeat consumed this occurrence's durable event by
    // its id; the shared settlement observer retires the matching copy.
    expect(shared.remove()).toBe(true);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("consumes only the leased occurrence's event id when a process slug is reused", () => {
    const reused = "exec:reused99";
    const older = enqueueSystemEventReceipt(
      "Exec completed (reused99, exit 0) :: older",
      { sessionKey: requesterSessionKey, contextKey: reused },
      { allowDuplicate: true },
    );
    const newer = enqueueSystemEventReceipt(
      "Exec completed (reused99, exit 0) :: newer",
      { sessionKey: requesterSessionKey, contextKey: reused },
      { allowDuplicate: true },
    );
    if (!older || !newer) {
      throw new Error("expected durable system event receipts");
    }
    // The older process's record was cleared, so a later process reused the slug
    // and two occurrences now share one `exec:<sessionId>` context key.
    enqueue({
      occurrenceKey: reused,
      execId: "reused99",
      durableEventId: older.eventId,
      text: "older",
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-1:exec-steering" }),
    ).toBe(1);
    // Only the leased occurrence settled; the newer one stays queued for its
    // own turn rather than being retired by the older occurrence's ack.
    expect(peekSystemEventEntries(requesterSessionKey).map((event) => event.id)).toEqual([
      newer.eventId,
    ]);
  });

  it("leaves an unowned newer occurrence alone when only steering settles", () => {
    const reused = "exec:control99";
    const older = enqueueSystemEventReceipt(
      "Exec completed (control99, exit 0) :: older",
      { sessionKey: requesterSessionKey, contextKey: reused },
      { allowDuplicate: true },
    );
    const newer = enqueueSystemEventReceipt(
      "Exec completed (control99, exit 0) :: newer",
      { sessionKey: requesterSessionKey, contextKey: reused },
      { allowDuplicate: true },
    );
    if (!older || !newer) {
      throw new Error("expected durable system event receipts");
    }
    enqueue({
      occurrenceKey: reused,
      execId: "control99",
      durableEventId: older.eventId,
      text: "older",
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    // A mismatched lease id settles nothing at all, so both occurrences survive.
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-2:exec-steering" }),
    ).toBe(0);
    expect(peekSystemEventEntries(requesterSessionKey).map((event) => event.id)).toEqual([
      older.eventId,
      newer.eventId,
    ]);
  });

  it("settles the steering copy by durable event id, not the reusable occurrence key", () => {
    // Two occurrences reuse the same exec:<sessionId> context across time, each
    // with its own globally-unique durable id. Consuming the first durable
    // event must retire only the first steering copy.
    const reused = "exec:reused01";
    const first = enqueueSystemEventReceipt("Exec completed (reused01, exit 0) :: first", {
      sessionKey: requesterSessionKey,
      contextKey: reused,
    });
    const second = enqueueSystemEventReceipt("Exec completed (reused01, exit 0) :: second", {
      sessionKey: requesterSessionKey,
      contextKey: reused,
    });
    if (!first || !second || first.eventId === second.eventId) {
      throw new Error("expected two distinct durable event ids under one context");
    }
    enqueue({
      occurrenceKey: reused,
      execId: "reused01",
      durableEventId: first.eventId,
      text: "first",
    });
    enqueue({
      occurrenceKey: reused,
      execId: "reused01",
      durableEventId: second.eventId,
      text: "second",
    });

    // Directly invalidating by the first durable id retires only its copy.
    expect(invalidateExecSteeringByDurableEventId(first.eventId)).toBe(1);
    const remaining = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(remaining?.itemIds).toHaveLength(1);
    expect(remaining?.prompt).toContain("second");
    expect(remaining?.prompt).not.toContain(":: first");
  });

  it("routes heartbeat/poll settlement through the shared observer to retire the steering copy", () => {
    // The exec-runtime path enqueues a durable event and a steering copy that
    // shares its id. Consuming that durable event on the settlement path (as a
    // delivered heartbeat does) must invalidate the steering copy through the
    // single registered consumption observer, keyed on the durable id.
    const { durableEventId } = enqueueSharedOccurrence({ execId: "obs00001", text: "observed" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    const consumed = consumeSelectedSystemEventEntries(requesterSessionKey, [
      { id: durableEventId, text: "", ts: 0 },
    ]);
    expect(consumed).toHaveLength(1);
    // The observer fired and retired the steering copy sharing that id.
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("retires the steering copy when a whole-queue drain settles the durable event", () => {
    const { durableEventId } = enqueueSharedOccurrence({ execId: "drain001", text: "drained" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
    const drained = drainSystemEventEntries(requesterSessionKey);
    expect(drained.some((event) => event.id === durableEventId)).toBe(true);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("re-registers the settlement observer after a reset via the exported entrypoint", () => {
    // The enqueue path registers the observer, but the entrypoint is also the
    // public contract: calling it after a reset restores the single membership
    // so a durable-event consumption fans out to the steering copy again.
    resetExecSteeringQueueForTest();
    resetSystemEventsForTest();
    ensureExecSteeringConsumptionObserver();
    const { durableEventId } = enqueueSharedOccurrence({
      execId: "reReg001",
      text: "re-registered",
    });
    consumeSelectedSystemEventEntries(requesterSessionKey, [
      { id: durableEventId, text: "", ts: 0 },
    ]);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("does not leak the settlement observer across a reset (isolation guard)", () => {
    // Register the observer via a first steered completion, then reset both
    // queues. A stale observer would fire against the fresh queue when the next
    // file's durable event is consumed; after reset it must be inert until a
    // new enqueue re-registers it.
    enqueueSharedOccurrence({ execId: "leak0001", text: "before reset" });
    resetExecSteeringQueueForTest();
    resetSystemEventsForTest();

    // A durable event consumed with no steering copy present must not throw and
    // must not resurrect anything: the observer set was cleared by the reset.
    const orphan = enqueueSystemEventReceipt("Exec completed (orphan01, exit 0) :: none", {
      sessionKey: requesterSessionKey,
      contextKey: "exec:orphan01",
    });
    if (!orphan) {
      throw new Error("expected an orphan durable receipt");
    }
    expect(() => orphan.remove()).not.toThrow();
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);

    // Re-enqueuing re-registers the observer, so settlement works again.
    const { durableEventId } = enqueueSharedOccurrence({ execId: "after001", text: "after reset" });
    consumeSelectedSystemEventEntries(requesterSessionKey, [
      { id: durableEventId, text: "", ts: 0 },
    ]);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("drops the settlement observer on queue reset even without a system-events reset", () => {
    // A test file may reset only the steering queue (its own state) and never
    // touch the shared system-events module. The queue reset must still drop
    // this queue's observer so it cannot fire against a later file's queue in a
    // shared, non-isolated worker. This is the cross-file leak that passed in
    // isolation but failed batched before the reset became self-contained.
    enqueueSharedOccurrence({ execId: "noSysRe", text: "registers the observer" });
    resetExecSteeringQueueForTest();

    // Simulate the next file enqueuing a durable event and consuming it. With a
    // leaked observer this consumption would fan out into the (now empty) queue;
    // the assertion here is simply that nothing throws and no phantom item is
    // resurrected. The observer must be inert until a fresh enqueue re-adds it.
    const orphan = enqueueSystemEventReceipt("Exec completed (nextfile, exit 0) :: none", {
      sessionKey: requesterSessionKey,
      contextKey: "exec:nextfile",
    });
    if (!orphan) {
      throw new Error("expected a durable receipt for the simulated next file");
    }
    expect(() => orphan.remove()).not.toThrow();
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);

    // A fresh enqueue re-registers the observer, so settlement fans out again.
    const { durableEventId } = enqueueSharedOccurrence({ execId: "reRe001", text: "re-armed" });
    consumeSelectedSystemEventEntries(requesterSessionKey, [
      { id: durableEventId, text: "", ts: 0 },
    ]);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("invalidates an already-leased copy before dispatch when its occurrence is acknowledged", () => {
    const shared = enqueueSharedOccurrence({ execId: "leased01" });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.isCurrent()).toBe(true);
    // A concurrent terminal poll settles the shared occurrence's durable event
    // by its id between lease and dispatch.
    expect(shared.remove()).toBe(true);
    // The pre-dispatch guard now rejects the stale leased copy.
    expect(leased?.isCurrent()).toBe(false);
  });

  it("retires queued completions when their conversation is reset", () => {
    enqueue({ occurrenceKey: "exec:reset001", execId: "reset001", text: "stale after reset" });
    // Leased but not yet acknowledged when the reset happens.
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const removed = retireExecSteeringForSessionKeys({
      requesterSessionKeys: [requesterSessionKey],
      ownerAgentId: "main",
    });
    expect(removed).toBe(1);
    // The reset conversation's next turn leases nothing stale.
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
  });

  it("does not ack with a mismatched lease id", () => {
    enqueue();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-2:exec-steering" }),
    ).toBe(0);
    // Still leased under the original id, so a fresh lease sees nothing.
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-3:exec-steering" }),
    ).toBeUndefined();
  });

  it("re-queues a released item for the next turn", () => {
    enqueue({ text: "needs retry" });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const released = releaseLeasedExecSteeringItems({
      itemIds: leased!.itemIds,
      leaseId: "run-1:exec-steering",
    });
    expect(released).toBe(1);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
    const released2 = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-2:exec-steering",
    });
    expect(released2?.itemIds).toEqual(leased!.itemIds);
    expect(released2?.prompt).toContain("needs retry");
  });

  it("steers multiple completions in requester order", () => {
    enqueue({ execId: "first111", text: "first output", endedAt: 1_000 });
    enqueue({ execId: "second22", text: "second output", endedAt: 2_000 });
    enqueue({ execId: "third333", text: "third output", endedAt: 3_000 });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(3);
    const firstIdx = leased!.prompt.indexOf("first output");
    const secondIdx = leased!.prompt.indexOf("second output");
    const thirdIdx = leased!.prompt.indexOf("third output");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("orders identically-timed completions by enqueue sequence", () => {
    enqueue({ execId: "aaa11111", text: "earlier enqueue", endedAt: 5_000 });
    enqueue({ execId: "bbb22222", text: "later enqueue", endedAt: 5_000 });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased!.prompt.indexOf("earlier enqueue")).toBeLessThan(
      leased!.prompt.indexOf("later enqueue"),
    );
  });

  it("prepends the steering prompt above the current parent turn", () => {
    const merged = prependExecSteeringPrompt({
      steeringPrompt: "STEER",
      prompt: "do the thing",
    });
    expect(merged).toBe("STEER\n\nCurrent parent turn:\n\ndo the thing");
  });

  it("returns only the steering prompt when the parent prompt is blank", () => {
    expect(prependExecSteeringPrompt({ steeringPrompt: "STEER", prompt: "   " })).toBe("STEER");
  });

  it("ignores an empty requester session key", () => {
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey: "   ",
        occurrenceKey: "exec:abcd1234",
        execId: "abcd1234",
        status: "completed",
        exitLabel: "exit 0",
        text: "ignored",
      }),
    ).toBeUndefined();
  });

  it("ignores an empty occurrence key", () => {
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey,
        occurrenceKey: "   ",
        execId: "abcd1234",
        status: "completed",
        exitLabel: "exit 0",
        text: "ignored",
      }),
    ).toBeUndefined();
  });

  it("revokes queued output when the physical session store is replaced", () => {
    publishSystemEventStoreResolver(() => "/stores/first.db");
    enqueue({
      occurrenceKey: "exec:store01",
      execId: "store01",
      durableEventId: "durable-store01",
    });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    // An accepted `session.store` replacement retires the canonical occurrence,
    // and the queued steering copy captured against the retired store is revoked
    // with it rather than reaching the replacement conversation's provider
    // request.
    publishSystemEventStoreResolver(() => "/stores/second.db");

    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("revokes an already-leased copy whose store is replaced before provider dispatch", () => {
    publishSystemEventStoreResolver(() => "/stores/first.db");
    enqueue({
      occurrenceKey: "exec:store03",
      execId: "store03",
      durableEventId: "durable-store03",
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.isCurrent()).toBe(true);
    publishSystemEventStoreResolver(() => "/stores/second.db");
    // The lease no longer has authority, so the embedded run refuses it before
    // it can reach the replacement conversation's provider request.
    expect(leased?.isCurrent()).toBe(false);
  });

  it("refuses a queued copy whose store was replaced before it could be leased", () => {
    publishSystemEventStoreResolver(() => "/stores/first.db");
    enqueue({
      occurrenceKey: "exec:store02",
      execId: "store02",
      durableEventId: "durable-store02",
    });
    publishSystemEventStoreResolver(() => "/stores/second.db");
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("refuses a copy whose session store the Gateway cannot resolve", () => {
    // The durable event is refused for the same key, so a steering copy would
    // deliver output the canonical path rejected and could never pass the
    // lease-time store check.
    publishSystemEventStoreResolver(() => {
      throw new Error("store unavailable");
    });
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey,
        occurrenceKey: "exec:nostore01",
        execId: "nostore01",
        status: "completed",
        exitLabel: "exit 0",
        text: "job done",
      }),
    ).toBeUndefined();
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("never leases a copy that lost store authority without a republish", () => {
    let storePath = "/stores/first.db";
    publishSystemEventStoreResolver(() => storePath);
    enqueue({
      occurrenceKey: "exec:drift01",
      execId: "drift01",
      durableEventId: "durable-drift01",
    });
    // The resolver now answers differently without the Gateway publishing a new
    // selection, so no retirement ran. The copy must be dropped at lease time
    // rather than leased with no authority, which would fail every turn.
    storePath = "/stores/second.db";
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("keeps queued output when the same physical store is republished", () => {
    publishSystemEventStoreResolver(() => "/stores/same.db");
    enqueue({
      occurrenceKey: "exec:same01",
      execId: "same01",
      durableEventId: "durable-same01",
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.isCurrent()).toBe(true);

    // A same-store republish keeps the canonical owner's facts, so the copy
    // keeps its authority and returns to the queue when the lease is released.
    publishSystemEventStoreResolver(() => "/stores/same.db");
    expect(leased?.isCurrent()).toBe(true);

    releaseLeasedExecSteeringItems({
      itemIds: leased!.itemIds,
      leaseId: "run-1:exec-steering",
    });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
  });

  it("clears queued entries on Gateway close", async () => {
    enqueue({
      occurrenceKey: "exec:close01",
      execId: "close01",
      durableEventId: "durable-close01",
    });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
    await drainGlobalSingletonLifecycleState("close");
    // A Gateway reopened in the same process must not inject this entry into a
    // later turn that reuses the session key.
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
  });

  it("clears an already-leased entry on Gateway close", async () => {
    enqueue({
      occurrenceKey: "exec:close02",
      execId: "close02",
      durableEventId: "durable-close02",
    });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.isCurrent()).toBe(true);
    await drainGlobalSingletonLifecycleState("close");
    // The lease lost its entry with the queue, so it can never reach provider
    // I/O from the closed Gateway's retained state.
    expect(leased?.isCurrent()).toBe(false);
  });

  it("keeps queued output across a same-process restart", async () => {
    enqueue({
      occurrenceKey: "exec:keep01",
      execId: "keep01",
      durableEventId: "durable-keep01",
    });
    await drainGlobalSingletonLifecycleState("restart");
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
  });

  it("keeps settlement wired across a same-process restart of the retained queues", async () => {
    const shared = enqueueSharedOccurrence({ execId: "restart01", text: "retained output" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    // A restart retains both the canonical queue and the steering queue, so the
    // settlement observer has to be retained with them.
    await drainGlobalSingletonLifecycleState("restart");
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    // Heartbeat consumes the retained occurrence before any later exec enqueue
    // could re-register a lazily-wired observer.
    expect(shared.remove()).toBe(true);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("retires the steering copy when an evicted completion is acknowledged", () => {
    const shared = enqueueSharedOccurrence({ execId: "evict001", text: "will be evicted" });

    // More than MAX_EVENTS newer system events evict this completion from the
    // canonical queue, while its steering copy is retained far longer.
    for (let index = 0; index < 25; index += 1) {
      enqueueSystemEventEntry(`Unrelated system event ${index}`, {
        sessionKey: requesterSessionKey,
      });
    }
    const queuedIds = peekSystemEventEntries(requesterSessionKey).map((event) => event.id);
    expect(queuedIds).not.toContain(shared.durableEventId);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    // A terminal poll acknowledges exactly this occurrence. The canonical entry
    // is already gone, so settlement has to reach the steering copy on its id.
    expect(shared.remove()).toBe(false);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("settles a heartbeat's saved snapshot after its entry was evicted before delivery", () => {
    const shared = enqueueSharedOccurrence({ execId: "hbevict1", text: "heartbeat snapshot" });

    // The heartbeat prepares its turn from a saved snapshot of the queue.
    const snapshot = peekSystemEventEntries(requesterSessionKey);
    expect(snapshot.map((event) => event.id)).toContain(shared.durableEventId);

    // Before its reply is delivered, more than MAX_EVENTS newer events evict
    // the saved occurrence from the live queue.
    for (let index = 0; index < 25; index += 1) {
      enqueueSystemEventEntry(`Newer system event ${index}`, {
        sessionKey: requesterSessionKey,
      });
    }
    expect(peekSystemEventEntries(requesterSessionKey).map((event) => event.id)).not.toContain(
      shared.durableEventId,
    );

    // Delivery succeeded, so the heartbeat settles exactly its saved snapshot.
    // Nothing of it is still resident, yet the delivered occurrence is settled.
    expect(consumeSelectedSystemEventEntries(requesterSessionKey, snapshot)).toEqual([]);

    // No second report: the steering copy cannot lease the completion again.
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "after-heartbeat" }),
    ).toBeUndefined();
  });

  it("does not retire a steering copy when a different occurrence is acknowledged", () => {
    enqueueSharedOccurrence({ execId: "bound001", text: "bound output" });
    const other = enqueueSystemEventReceipt(
      "Exec completed (other001, exit 0) :: other output",
      { sessionKey: requesterSessionKey, contextKey: "exec:other001" },
      { allowDuplicate: true },
    );
    if (!other) {
      throw new Error("expected a durable system event receipt");
    }
    // Acknowledging an unrelated occurrence settles nothing here. A context-wide
    // or blanket notification would wrongly retire the bound copy.
    expect(other.remove()).toBe(true);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
  });

  describe("delivery settlement", () => {
    const leaseId = "run-1:exec-steering";

    function leaseShared(execId: string) {
      const shared = enqueueSharedOccurrence({ execId });
      const leased = leasePendingExecSteeringItems({ requesterSessionKey, leaseId, now: 1_000 });
      if (!leased) {
        throw new Error("expected a leased batch");
      }
      return { shared, leased };
    }

    it("holds a dispatched lease out of the stale re-lease sweep until delivery settles", () => {
      const { shared, leased } = leaseShared("hold0001");
      const settlement = holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId });
      expect(settlement).toBeDefined();

      // Long past the stale window, an in-progress lease would be re-offered;
      // a held one waits for its delivery owner.
      expect(
        leasePendingExecSteeringItems({
          requesterSessionKey,
          leaseId: "run-2:exec-steering",
          now: 1_000 + 24 * 60 * 60 * 1000,
        }),
      ).toBeUndefined();
      expect(peekSystemEventEntries(shared.queueKey).map((e) => e.id)).toEqual([
        shared.durableEventId,
      ]);
    });

    it("retires the copy and its durable event when the reply is delivered", () => {
      const { shared, leased } = leaseShared("deliv001");
      holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId })?.settle(true);

      expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
      expect(peekSystemEventEntries(shared.queueKey)).toEqual([]);
    });

    it("returns the copy and keeps its durable event when the reply is not delivered", () => {
      const { shared, leased } = leaseShared("fail0001");
      holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId })?.settle(false);

      // The durable event survives for the idle heartbeat, and the next turn
      // re-leases the same completion.
      expect(peekSystemEventEntries(shared.queueKey).map((e) => e.id)).toEqual([
        shared.durableEventId,
      ]);
      const next = leasePendingExecSteeringItems({
        requesterSessionKey,
        leaseId: "run-2:exec-steering",
      });
      expect(next?.itemIds).toEqual(leased.itemIds);
      expect(next?.prompt).toContain("fail0001");
    });

    it("settles only once", () => {
      const { shared, leased } = leaseShared("once0001");
      const settlement = holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId });
      settlement?.settle(false);
      const next = leasePendingExecSteeringItems({
        requesterSessionKey,
        leaseId: "run-2:exec-steering",
      });
      // A late "delivered" from the first turn cannot retire the re-leased copy.
      settlement?.settle(true);
      expect(next?.isCurrent()).toBe(true);
      expect(peekSystemEventEntries(shared.queueKey)).toHaveLength(1);
    });

    it("returns no receipt when the occurrence was consumed elsewhere before the hold", () => {
      const { shared, leased } = leaseShared("gone0001");
      expect(shared.remove()).toBe(true);
      expect(holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId })).toBeUndefined();
    });

    it("drops a held copy whose durable event a heartbeat consumed while it waited", () => {
      const { shared, leased } = leaseShared("hbeat001");
      const settlement = holdExecSteeringForDelivery({ itemIds: leased.itemIds, leaseId });
      expect(shared.remove()).toBe(true);
      settlement?.settle(false);
      expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    });
  });
});
