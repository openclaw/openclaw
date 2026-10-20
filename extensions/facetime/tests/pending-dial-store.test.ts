import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PendingFaceTimeDial } from "../src/outbound-call.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";
import { pendingDial as makePendingDial } from "./fixtures.test-support.js";

type StoredDial = Omit<PendingFaceTimeDial, "callUUIDAliases"> & {
  callUUIDAliases?: string[];
};

const deferred = () => Promise.withResolvers<void>();
function track<T>(promise: Promise<T>) {
  const tracked = {
    settled: false,
    promise: promise.then((result) => {
      tracked.settled = true;
      return result;
    }),
  };
  return tracked;
}

const pendingDial = (dialID = "dial-a") =>
  makePendingDial({
    dialID,
    delivery: "in-flight",
    requestedAt: "2026-09-20T12:00:00.000Z",
  });

function createBackend(initial?: StoredDial) {
  let value = initial;
  let revision = 0;
  const writes: StoredDial[] = [];
  const replace = (next: StoredDial | undefined) => {
    value = next;
    revision += 1;
  };
  const write = async (_key: string, next: StoredDial) => {
    writes.push(next);
    replace(next);
  };
  const unexpectedOperation = async () => {
    throw new Error("unexpected unconditional storage operation");
  };
  const store = {
    register: vi.fn(write),
    lookup: vi.fn(async (_key: string) => value),
    observe: vi.fn(async (_key: string) => ({ value, comparison: String(revision) })),
    compareAndApply: vi.fn<PluginStateKeyedStore<StoredDial, 2>["compareAndApply"]>(
      async (_key, comparison, intent) => {
        if (comparison !== String(revision)) {
          return { status: "conflict", current: { value, comparison: String(revision) } };
        }
        if (intent.action === "delete") {
          replace(undefined);
          return { status: "applied" };
        }
        return { status: "unchanged" };
      },
    ),
    registerIfAbsent: vi.fn(unexpectedOperation),
    consume: vi.fn(unexpectedOperation),
    delete: vi.fn(unexpectedOperation),
    entries: vi.fn(unexpectedOperation),
    clear: vi.fn(unexpectedOperation),
    lookupMany: vi.fn(unexpectedOperation),
    deleteIfEqual: vi.fn(unexpectedOperation),
    entriesInKeyRange: vi.fn(unexpectedOperation),
    moveEntriesFrom: vi.fn(unexpectedOperation),
    count: vi.fn(unexpectedOperation),
  } satisfies PluginStateKeyedStore<StoredDial, 2>;
  const backend = { store, writes, write, replace, current: () => value };
  return [new PendingFaceTimeDialStore(store), backend] as const;
}

describe("pending FaceTime dial persistence", () => {
  it("snapshots queued saves and settles their FIFO writes before conditional clear", async () => {
    const [store, backend] = createBackend();
    const entered = deferred();
    const release = deferred();
    backend.store.register.mockImplementationOnce(async (key, value) => {
      entered.resolve();
      await release.promise;
      await backend.write(key, value);
    });
    const pending = pendingDial();
    pending.callUUIDAliases = new Set(["z-call", "a-call"]);
    const first = store.save(pending);
    await entered.promise;

    pending.delivery = "cancelling";
    pending.callUUIDAliases.add("m-call");
    const second = store.save(pending);
    pending.delivery = "accepted";
    pending.callUUIDAliases.add("later-call");
    const cleared = store.clear(pending.dialID);
    const settlement = track(store.settle());
    await Promise.resolve();

    expect(settlement.settled).toBe(false);
    expect(backend.store.register).toHaveBeenCalledTimes(1);
    expect(backend.store.observe).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second, settlement.promise]);
    await expect(cleared).resolves.toBe(true);
    expect(backend.writes).toMatchObject([
      { delivery: "in-flight", callUUIDAliases: ["a-call", "z-call"] },
      { delivery: "cancelling", callUUIDAliases: ["a-call", "m-call", "z-call"] },
    ]);
    expect(backend.current()).toBeUndefined();
    expect(backend.store.delete).not.toHaveBeenCalled();
  });

  it("joins late same-dial saves and repeated clears without resurrecting a clearing dial", async () => {
    const pending = pendingDial();
    const [store, backend] = createBackend({ ...pending, callUUIDAliases: ["a-call"] });
    const entered = deferred();
    const release = deferred();
    backend.store.observe.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { value: backend.current(), comparison: "0" };
    });
    const clearing = store.clear(pending.dialID);
    await entered.promise;

    const lateSave = store.save({ ...pending, delivery: "accepted" });
    const repeatedClear = store.clear(pending.dialID);
    const settlement = track(Promise.all([clearing, lateSave, repeatedClear, store.settle()]));
    await Promise.resolve();

    expect(store.isClearing(pending.dialID)).toBe(true);
    expect(settlement.settled).toBe(false);
    expect(backend.store.register).not.toHaveBeenCalled();
    release.resolve();
    await expect(settlement.promise).resolves.toEqual([true, undefined, true, undefined]);

    expect(store.isClearing(pending.dialID)).toBe(false);
    expect(backend.store.observe).toHaveBeenCalledOnce();
    expect(backend.store.compareAndApply).toHaveBeenCalledExactlyOnceWith("active", "0", {
      operation: "delete",
      action: "delete",
    });
    expect(backend.store.register).not.toHaveBeenCalled();
    expect(backend.current()).toBeUndefined();
  });

  it.each([
    { dialID: "dial-b", action: "keep", cleared: false },
    { dialID: "dial-a", action: "delete", cleared: true },
  ])("retries conflicts and applies $action to $dialID", async ({ dialID, action, cleared }) => {
    const [store, backend] = createBackend({ ...pendingDial(), callUUIDAliases: ["a-call"] });
    const replacement: StoredDial = {
      ...pendingDial(dialID),
      delivery: "cancelling",
      callUUIDAliases: ["b-call"],
    };
    backend.store.compareAndApply.mockImplementationOnce(async () => {
      backend.replace(replacement);
      return { status: "conflict", current: { value: replacement, comparison: "1" } };
    });
    await expect(store.clear("dial-a")).resolves.toBe(cleared);
    expect(backend.current()).toEqual(cleared ? undefined : replacement);
    expect(backend.store.compareAndApply).toHaveBeenCalledTimes(2);
    expect(backend.store.compareAndApply).toHaveBeenLastCalledWith("active", "1", {
      operation: "delete",
      action,
    });
    expect(backend.store.delete).not.toHaveBeenCalled();
  });

  it("propagates a comparison transport failure without retrying", async () => {
    const initial: StoredDial = { ...pendingDial(), callUUIDAliases: ["a-call"] };
    const [store, backend] = createBackend(initial);
    const failure = new Error("worker transport lost after dispatch");
    backend.store.compareAndApply.mockRejectedValueOnce(failure);

    await expect(store.clear("dial-a")).rejects.toBe(failure);

    expect(backend.store.compareAndApply).toHaveBeenCalledTimes(1);
    expect(backend.store.delete).not.toHaveBeenCalled();
    expect(backend.current()).toEqual(initial);
  });
});
