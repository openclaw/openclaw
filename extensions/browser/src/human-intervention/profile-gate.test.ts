import { describe, expect, it, vi } from "vitest";
import { HumanInterventionProfileGate } from "./profile-gate.js";
import { HumanInterventionConflictError } from "./service.js";

const browser = { target: "host", profile: "openclaw", targetId: "tab-1" } as const;

describe("HumanInterventionProfileGate", () => {
  it("drains active automation and blocks new work before reserving the profile", async () => {
    let reserved = false;
    const gate = new HumanInterventionProfileGate({
      getProfileReservation: vi.fn(async () =>
        reserved ? ({ id: "handoff-1" } as never) : undefined,
      ),
    });
    const release = await gate.beginAutomation(browser);
    const createReservation = vi.fn(async () => {
      reserved = true;
      return "reserved";
    });
    const reservation = gate.reserve(browser, createReservation);
    await Promise.resolve();
    expect(createReservation).not.toHaveBeenCalled();
    await expect(gate.beginAutomation(browser)).rejects.toBeInstanceOf(
      HumanInterventionConflictError,
    );

    await release();
    await expect(reservation).resolves.toBe("reserved");
    await expect(gate.beginAutomation(browser)).rejects.toBeInstanceOf(
      HumanInterventionConflictError,
    );
  });
});
