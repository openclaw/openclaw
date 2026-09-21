import type {
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PendingFaceTimeDial } from "../src/outbound-call.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";

type StoredDial = Omit<PendingFaceTimeDial, "callUUIDAliases"> & {
  callUUIDAliases?: string[];
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pendingDial(dialID = "dial-a"): PendingFaceTimeDial {
  return {
    dialID,
    version: 1,
    ownerEpoch: 1,
    handle: "owner@example.com",
    mode: "audio",
    delivery: "in-flight",
    requestedAt: "2026-09-20T12:00:00.000Z",
  };
}

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
    compareAndApply: vi.fn(
      async (
        _key: string,
        comparison: string,
        intent: PluginStateCompareIntent<StoredDial>,
      ): Promise<PluginStateCompareResult<StoredDial>> => {
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
    deleteIf: vi.fn(async (_key: string, predicate: (current: StoredDial) => boolean) => {
      if (!value || !predicate(value)) {
        return false;
      }
      replace(undefined);
      return true;
    }),
    registerIfAbsent: vi.fn(unexpectedOperation),
    consume: vi.fn(unexpectedOperation),
    delete: vi.fn(unexpectedOperation),
    entries: vi.fn(unexpectedOperation),
    clear: vi.fn(unexpectedOperation),
  } satisfies PluginStateKeyedStore<StoredDial>;
  return { store, writes, write, replace, current: () => value };
}

describe("pending FaceTime dial persistence", () => {
  it("snapshots queued saves and settles their FIFO writes before conditional clear", async () => {
    const backend = createBackend();
    const entered = deferred();
    const release = deferred();
    backend.store.register.mockImplementationOnce(async (key, value) => {
      entered.resolve();
      await release.promise;
      await backend.write(key, value);
    });
    const store = new PendingFaceTimeDialStore(backend.store);
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
    let settled = false;
    const settlement = store.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(backend.store.register).toHaveBeenCalledTimes(1);
    expect(backend.store.observe).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second, settlement]);
    await expect(cleared).resolves.toBe(true);
    expect(backend.writes).toMatchObject([
      { delivery: "in-flight", callUUIDAliases: ["a-call", "z-call"] },
      { delivery: "cancelling", callUUIDAliases: ["a-call", "m-call", "z-call"] },
    ]);
    expect(backend.current()).toBeUndefined();
    expect(backend.store.deleteIf).not.toHaveBeenCalled();
    expect(backend.store.delete).not.toHaveBeenCalled();
  });

  it("joins late same-dial saves and repeated clears without resurrecting a clearing dial", async () => {
    const pending = pendingDial();
    const backend = createBackend({ ...pending, callUUIDAliases: ["a-call"] });
    const entered = deferred();
    const release = deferred();
    backend.store.observe.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { value: backend.current(), comparison: "0" };
    });
    const store = new PendingFaceTimeDialStore(backend.store);
    const clearing = store.clear(pending.dialID);
    await entered.promise;

    const lateSave = store.save({ ...pending, delivery: "accepted" });
    const repeatedClear = store.clear(pending.dialID);
    let settled = false;
    const settlement = Promise.all([clearing, lateSave, repeatedClear, store.settle()]).then(
      (results) => {
        settled = true;
        return results;
      },
    );
    await Promise.resolve();

    expect(store.isClearing(pending.dialID)).toBe(true);
    expect(settled).toBe(false);
    expect(backend.store.register).not.toHaveBeenCalled();
    release.resolve();
    await expect(settlement).resolves.toEqual([true, undefined, true, undefined]);

    expect(store.isClearing(pending.dialID)).toBe(false);
    expect(backend.store.observe).toHaveBeenCalledOnce();
    expect(backend.store.compareAndApply).toHaveBeenCalledExactlyOnceWith("active", "0", {
      operation: "delete",
      action: "delete",
    });
    expect(backend.store.register).not.toHaveBeenCalled();
    expect(backend.current()).toBeUndefined();
  });

  it("preserves a replacement dial when conditional clear encounters a conflict", async () => {
    const backend = createBackend({ ...pendingDial(), callUUIDAliases: ["a-call"] });
    const replacement: StoredDial = { ...pendingDial("dial-b"), callUUIDAliases: ["b-call"] };
    backend.store.compareAndApply.mockImplementationOnce(async () => {
      backend.replace(replacement);
      return { status: "conflict", current: { value: replacement, comparison: "1" } };
    });
    const store = new PendingFaceTimeDialStore(backend.store);

    await expect(store.clear("dial-a")).resolves.toBe(false);

    expect(backend.current()).toEqual(replacement);
    expect(backend.store.compareAndApply).toHaveBeenCalledTimes(2);
    expect(backend.store.compareAndApply).toHaveBeenLastCalledWith("active", "1", {
      operation: "delete",
      action: "keep",
    });
    expect(backend.store.deleteIf).not.toHaveBeenCalled();
    expect(backend.store.delete).not.toHaveBeenCalled();
  });

  it("retries an explicit conflict while the observed dial still matches", async () => {
    const initial: StoredDial = { ...pendingDial(), callUUIDAliases: ["a-call"] };
    const backend = createBackend(initial);
    backend.store.compareAndApply.mockImplementationOnce(async () => {
      const updated = { ...initial, delivery: "cancelling" as const };
      backend.replace(updated);
      return { status: "conflict", current: { value: updated, comparison: "1" } };
    });
    const store = new PendingFaceTimeDialStore(backend.store);

    await expect(store.clear("dial-a")).resolves.toBe(true);

    expect(backend.store.compareAndApply).toHaveBeenCalledTimes(2);
    expect(backend.store.compareAndApply).toHaveBeenLastCalledWith("active", "1", {
      operation: "delete",
      action: "delete",
    });
    expect(backend.current()).toBeUndefined();
    expect(backend.store.deleteIf).not.toHaveBeenCalled();
  });

  it("propagates a comparison transport failure without retrying or falling back", async () => {
    const initial: StoredDial = { ...pendingDial(), callUUIDAliases: ["a-call"] };
    const backend = createBackend(initial);
    const failure = new Error("worker transport lost after dispatch");
    backend.store.compareAndApply.mockRejectedValueOnce(failure);
    const store = new PendingFaceTimeDialStore(backend.store);

    await expect(store.clear("dial-a")).rejects.toBe(failure);

    expect(backend.store.compareAndApply).toHaveBeenCalledTimes(1);
    expect(backend.store.deleteIf).not.toHaveBeenCalled();
    expect(backend.store.delete).not.toHaveBeenCalled();
    expect(backend.current()).toEqual(initial);
  });

  it.each(["observe", "compareAndApply", "both"] as const)(
    "uses legacy atomic deletion when %s is unavailable",
    async (missing) => {
      const backend = createBackend({ ...pendingDial(), callUUIDAliases: ["a-call"] });
      const store = new PendingFaceTimeDialStore({
        ...backend.store,
        observe: missing === "compareAndApply" ? backend.store.observe : undefined,
        compareAndApply: missing === "observe" ? backend.store.compareAndApply : undefined,
      });

      await expect(store.clear("dial-b")).resolves.toBe(false);
      expect(backend.current()?.dialID).toBe("dial-a");
      await expect(store.clear("dial-a")).resolves.toBe(true);

      expect(backend.current()).toBeUndefined();
      expect(backend.store.deleteIf).toHaveBeenCalledTimes(2);
      expect(backend.store.observe).not.toHaveBeenCalled();
      expect(backend.store.compareAndApply).not.toHaveBeenCalled();
      expect(backend.store.lookup).not.toHaveBeenCalled();
      expect(backend.store.delete).not.toHaveBeenCalled();
    },
  );
});
