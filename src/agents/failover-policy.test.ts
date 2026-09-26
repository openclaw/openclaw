// Documents how failover reasons map to cooldown probe slot decisions.
import { describe, expect, it } from "vitest";
import type { FailoverReason } from "./embedded-agent-helpers.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";

type ReasonCase = [
  reason: FailoverReason | null | undefined,
  allowCooldownProbe: boolean,
  useTransientProbeSlot: boolean,
  preserveTransientProbeSlot: boolean,
];

const CASES: ReasonCase[] = [
  ["rate_limit", true, true, false],
  ["overloaded", true, true, false],
  ["billing", true, false, false],
  ["unknown", true, true, false],
  ["empty_response", true, true, false],
  ["no_error_details", true, true, false],
  ["unclassified", true, true, false],
  ["model_not_found", false, false, true],
  ["format", false, false, true],
  ["auth", false, false, true],
  ["auth_permanent", false, false, true],
  ["session_expired", false, false, true],
  ["timeout", true, true, false],
  [null, false, false, false],
  [undefined, false, false, false],
];

describe("failover-policy", () => {
  it("maps failover reasons to cooldown-probe decisions", () => {
    for (const [reason, allow, useTransient, preserveTransient] of CASES) {
      expect(shouldAllowCooldownProbeForReason(reason)).toBe(allow);
      expect(shouldUseTransientCooldownProbeSlot(reason)).toBe(useTransient);
      expect(shouldPreserveTransientCooldownProbeSlot(reason)).toBe(preserveTransient);
    }
  });
});
