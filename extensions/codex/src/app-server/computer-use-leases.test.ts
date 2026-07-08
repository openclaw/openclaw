// Codex tests cover Computer Use window-scope lease behavior.
import { describe, expect, it } from "vitest";
import { CodexComputerUseWindowLeaseManager } from "./computer-use-leases.js";

describe("Codex Computer Use window leases", () => {
  it("allows simultaneous leases for different windows", () => {
    let now = 1_000;
    let nextId = 1;
    const leases = new CodexComputerUseWindowLeaseManager({
      now: () => now,
      idFactory: () => `lease-${nextId++}`,
    });

    const first = leases.acquire({ windowId: "chrome:1", holderId: "emmerich" });
    const second = leases.acquire({ windowId: "chrome:2", holderId: "julian" });

    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(
      leases
        .snapshot()
        .map((lease) => lease.windowId)
        .toSorted(),
    ).toEqual(["chrome:1", "chrome:2"]);
    now += 1;
  });

  it("blocks a second holder on the same window and records preemption requests", () => {
    const leases = new CodexComputerUseWindowLeaseManager({
      now: () => 10_000,
      idFactory: () => "lease-1",
    });
    const first = leases.acquire({ windowId: "chrome:1", holderId: "emmerich" });
    expect(first.granted).toBe(true);

    const second = leases.acquire({
      windowId: "chrome:1",
      holderId: "julian",
      requestPreemption: true,
    });

    expect(second).toMatchObject({
      granted: false,
      reason: "window_busy",
      preemptionRequested: true,
    });
    expect(leases.snapshot()[0]?.preemptionRequested).toBe(true);
  });

  it("renews active leases while tool calls are running", () => {
    let now = 0;
    const leases = new CodexComputerUseWindowLeaseManager({
      now: () => now,
      idFactory: () => "lease-1",
      defaultTimeoutMs: 300_000,
    });
    const acquired = leases.acquire({ windowId: "chrome:1", holderId: "emmerich" });
    if (!acquired.granted) {
      throw new Error("expected lease");
    }
    expect(acquired.lease.expiresAtMs).toBe(300_000);

    now = 299_000;
    const active = leases.beginToolCall(acquired.lease.id);
    expect(active?.toolCallsActive).toBe(1);
    expect(active?.expiresAtMs).toBe(599_000);

    now = 599_500;
    expect(leases.snapshot()).toHaveLength(1);
    leases.endToolCall(acquired.lease.id);
    now = 900_000;
    expect(leases.snapshot()).toHaveLength(0);
  });
});
