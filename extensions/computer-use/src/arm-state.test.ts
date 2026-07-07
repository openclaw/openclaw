import { describe, expect, it, vi } from "vitest";
import {
  deleteComputerArmState,
  isArmed,
  readComputerArmState,
  writeComputerArmState,
  type ComputerArmState,
  type ComputerArmStore,
} from "./arm-state.js";

function createStore(): ComputerArmStore {
  const values = new Map<string, ComputerArmState>();
  return {
    lookup: vi.fn(async (key) => values.get(key)),
    register: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => values.delete(key)),
    entries: vi.fn(async () =>
      [...values].map(([key, value]) => ({ key, value, createdAt: value.armedAtMs })),
    ),
  };
}

describe("computer arm state", () => {
  it.each([
    ["missing", null, 1000, false],
    ["manual", { armedAtMs: 100, expiresAtMs: null }, 1000, true],
    ["future expiry", { armedAtMs: 100, expiresAtMs: 1001 }, 1000, true],
    ["exact expiry", { armedAtMs: 100, expiresAtMs: 1000 }, 1000, false],
    ["past expiry", { armedAtMs: 100, expiresAtMs: 999 }, 1000, false],
  ] as const)("reports %s state", (_label, state, nowMs, expected) => {
    expect(isArmed(state, nowMs)).toBe(expected);
  });

  it("round-trips and deletes node-scoped state", async () => {
    const store = createStore();
    const state = { armedAtMs: 1000, expiresAtMs: 2000, armedBy: "operator-1" };

    expect(await readComputerArmState(store, "node-1")).toBeNull();
    await writeComputerArmState(store, "node-1", state);
    expect(await readComputerArmState(store, "node-1")).toEqual(state);
    expect(await deleteComputerArmState(store, "node-1")).toBe(true);
    expect(await readComputerArmState(store, "node-1")).toBeNull();
  });
});
