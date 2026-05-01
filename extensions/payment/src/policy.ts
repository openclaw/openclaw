import type { PaymentRail } from "./types.js";

/**
 * Error thrown when a requested payment amount exceeds the configured cap.
 */
export class MaxAmountExceededError extends Error {
  readonly maxCents: number;
  readonly requestedCents: number;

  constructor(maxCents: number, requestedCents: number) {
    super(`Payment amount ${requestedCents} cents exceeds the maximum allowed ${maxCents} cents.`);
    this.name = "MaxAmountExceededError";
    this.maxCents = maxCents;
    this.requestedCents = requestedCents;
  }
}

/**
 * V1 policy: all payment actions require explicit approval.
 * This function exists for future-proofing — the body is hardcoded to return true.
 */
export function requiresApprovalForAction(
  action: "issue_virtual_card" | "execute_machine_payment" | "fill_substitution",
): boolean {
  // Approval is always required in V1. No knobs yet — see plan R14.
  void action;
  return true;
}

/**
 * Returns true iff `requestedRail` appears in `adapterRails`.
 */
export function canRail(adapterRails: readonly PaymentRail[], requestedRail: PaymentRail): boolean {
  return adapterRails.includes(requestedRail);
}

/**
 * Throws MaxAmountExceededError if requestedCents > maxCents. No-op otherwise.
 */
export function enforceMaxAmount(maxCents: number, requestedCents: number): void {
  if (requestedCents > maxCents) {
    throw new MaxAmountExceededError(maxCents, requestedCents);
  }
}
