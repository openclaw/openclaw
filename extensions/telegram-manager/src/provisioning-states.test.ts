import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminalState,
  nextStateOnSuccess,
  PROVISIONING_STATES,
} from "../src/provisioning-states.js";

describe("provisioning state machine", () => {
  it("covers the required 9-state flow", () => {
    expect(PROVISIONING_STATES).toEqual([
      "REQUESTED",
      "CREATING_BOT",
      "BOT_CREATED",
      "CREATING_SERVER",
      "SERVER_CREATED",
      "INSTALLING_OPENCLAW",
      "CONFIGURING_OPENCLAW",
      "VERIFYING",
      "READY",
      "FAILED",
    ]);
  });

  it("advances linearly on success", () => {
    expect(nextStateOnSuccess("REQUESTED")).toBe("CREATING_BOT");
    expect(nextStateOnSuccess("VERIFYING")).toBe("READY");
    expect(nextStateOnSuccess("READY")).toBeUndefined();
  });

  it("allows any state to fail and FAILED to retry", () => {
    for (const s of PROVISIONING_STATES) {
      if (s === "READY" || s === "FAILED") {
        continue;
      }
      expect(canTransition(s, "FAILED")).toBe(true);
    }
    expect(canTransition("FAILED", "REQUESTED")).toBe(true);
    expect(canTransition("READY", "FAILED")).toBe(false);
  });

  it("rejects skips", () => {
    expect(canTransition("REQUESTED", "READY")).toBe(false);
    expect(() => assertTransition("REQUESTED", "READY")).toThrow();
  });

  it("marks READY/FAILED terminal", () => {
    expect(isTerminalState("READY")).toBe(true);
    expect(isTerminalState("FAILED")).toBe(true);
    expect(isTerminalState("VERIFYING")).toBe(false);
  });
});
