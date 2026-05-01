import { describe, expect, it } from "vitest";
import {
  MaxAmountExceededError,
  canRail,
  enforceMaxAmount,
  requiresApprovalForAction,
} from "./policy.js";

describe("requiresApprovalForAction", () => {
  it("returns true for issue_virtual_card", () => {
    expect(requiresApprovalForAction("issue_virtual_card")).toBe(true);
  });

  it("returns true for execute_machine_payment", () => {
    expect(requiresApprovalForAction("execute_machine_payment")).toBe(true);
  });

  it("returns true for fill_substitution", () => {
    expect(requiresApprovalForAction("fill_substitution")).toBe(true);
  });
});

describe("canRail", () => {
  it("returns true when requested rail is in adapter list", () => {
    expect(canRail(["virtual_card", "machine_payment"], "virtual_card")).toBe(true);
    expect(canRail(["virtual_card", "machine_payment"], "machine_payment")).toBe(true);
  });

  it("returns false when requested rail is not in adapter list", () => {
    expect(canRail(["virtual_card"], "machine_payment")).toBe(false);
  });

  it("returns false for empty adapter rails list", () => {
    expect(canRail([], "virtual_card")).toBe(false);
    expect(canRail([], "machine_payment")).toBe(false);
  });

  it("returns true for single-rail adapter matching the request", () => {
    expect(canRail(["machine_payment"], "machine_payment")).toBe(true);
  });
});

describe("enforceMaxAmount", () => {
  it("throws MaxAmountExceededError when requestedCents > maxCents", () => {
    expect(() => enforceMaxAmount(50000, 50001)).toThrow(MaxAmountExceededError);
  });

  it("thrown error carries maxCents and requestedCents", () => {
    let caught: MaxAmountExceededError | undefined;
    try {
      enforceMaxAmount(50000, 60000);
    } catch (err) {
      caught = err as MaxAmountExceededError;
    }
    expect(caught).toBeInstanceOf(MaxAmountExceededError);
    expect(caught?.maxCents).toBe(50000);
    expect(caught?.requestedCents).toBe(60000);
  });

  it("does not throw when requestedCents === maxCents (boundary)", () => {
    expect(() => enforceMaxAmount(50000, 50000)).not.toThrow();
  });

  it("does not throw when requestedCents < maxCents", () => {
    expect(() => enforceMaxAmount(50000, 100)).not.toThrow();
  });

  it("does not throw when requestedCents = 0 (degenerate, but valid)", () => {
    expect(() => enforceMaxAmount(50000, 0)).not.toThrow();
  });
});
