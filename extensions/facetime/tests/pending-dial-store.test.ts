import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { expect, it, vi } from "vitest";
import {
  createAsyncGate,
  trackPromiseFulfillment as track,
} from "../../test-support/async-gate.test-support.js";
import type { PendingFaceTimeDial } from "../src/outbound-call.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";
import { pendingDial as makePendingDial } from "./fixtures.test-support.js";

type StoredDial = Omit<PendingFaceTimeDial, "callUUIDAliases"> & {
  callUUIDAliases?: string[];
};

const pendingDial = (dialID = "dial-a") => makePendingDial({ dialID, delivery: "in-flight" });
const storedDial = (dialID = "dial-a"): StoredDial => ({
  ...pendingDial(dialID),
  callUUIDAliases: ["a-call"],
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

it("snapshots FIFO saves, then joins late saves and repeated clears until deletion settles", async () => {
  const [store, backend] = createBackend();
  const gate = createAsyncGate();
  const deletion = createAsyncGate();
  const observe = backend.store.observe.getMockImplementation()!;
  backend.store.observe.mockImplementationOnce(async (key) => {
    await deletion.wait();
    return observe(key);
  });
  backend.store.register.mockImplementationOnce(async (key, value) => {
    await gate.wait();
    await backend.write(key, value);
  });
  const pending = pendingDial();
  pending.callUUIDAliases = new Set(["z-call", "a-call"]);
  const first = store.save(pending);
  await gate.entered;

  pending.delivery = "cancelling";
  pending.callUUIDAliases.add("m-call");
  const second = store.save(pending);
  pending.delivery = "accepted";
  pending.callUUIDAliases.add("later-call");
  const cleared = store.clear(pending.dialID);
  const settlement = track(store.settle());
  await Promise.resolve();

  expect(settlement.settled).toBe(false);
  gate.release();
  await Promise.all([first, second, deletion.entered]);
  expect(store.isClearing(pending.dialID)).toBe(true);
  const lateSave = store.save({ ...pending, delivery: "accepted" });
  const repeatedClear = store.clear(pending.dialID);
  expect(settlement.settled).toBe(false);
  deletion.release();
  await expect(
    Promise.all([cleared, lateSave, repeatedClear, settlement.promise]),
  ).resolves.toEqual([true, undefined, true, undefined]);
  expect(backend.writes).toMatchObject([
    { delivery: "in-flight", callUUIDAliases: ["a-call", "z-call"] },
    { delivery: "cancelling", callUUIDAliases: ["a-call", "m-call", "z-call"] },
  ]);
  expect(store.isClearing(pending.dialID)).toBe(false);
  expect(backend.current()).toBeUndefined();
});

it.each([
  { dialID: "dial-b", action: "keep", cleared: false },
  { dialID: "dial-a", action: "delete", cleared: true },
])("retries conflicts and applies $action to $dialID", async ({ dialID, cleared }) => {
  const [store, backend] = createBackend(storedDial());
  const replacement = storedDial(dialID);
  backend.store.compareAndApply.mockImplementationOnce(async () => {
    backend.replace(replacement);
    return { status: "conflict", current: { value: replacement, comparison: "1" } };
  });
  await expect(store.clear("dial-a")).resolves.toBe(cleared);
  expect(backend.current()).toEqual(cleared ? undefined : replacement);
});

it("propagates a comparison transport failure without retrying", async () => {
  const initial = storedDial();
  const [store, backend] = createBackend(initial);
  const failure = new Error("worker transport lost after dispatch");
  backend.store.compareAndApply.mockRejectedValueOnce(failure);

  await expect(store.clear("dial-a")).rejects.toBe(failure);

  expect(backend.store.compareAndApply).toHaveBeenCalledTimes(1);
  expect(backend.current()).toEqual(initial);
});
