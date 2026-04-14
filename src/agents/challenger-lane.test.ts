import { describe, expect, it } from "vitest";
import { isChallengerEnabled, shouldInvokeChallenger } from "./challenger-lane.js";

describe("challenger-lane", () => {
  describe("isChallengerEnabled", () => {
    it("returns false by default", () => {
      expect(isChallengerEnabled()).toBe(false);
      expect(isChallengerEnabled({})).toBe(false);
    });

    it("returns true when enabled", () => {
      expect(isChallengerEnabled({ enabled: true })).toBe(true);
    });
  });

  describe("shouldInvokeChallenger", () => {
    it("returns false when disabled", () => {
      const result = shouldInvokeChallenger({
        trigger: "user_requested",
      });
      expect(result.invoke).toBe(false);
      expect(result.reason).toBe("challenger_lane_disabled");
    });

    it("invokes for user_requested when enabled", () => {
      const result = shouldInvokeChallenger({
        config: { enabled: true },
        trigger: "user_requested",
      });
      expect(result.invoke).toBe(true);
    });

    it("requires revise count >= 2 for revise_loop_exceeded", () => {
      expect(
        shouldInvokeChallenger({
          config: { enabled: true },
          trigger: "revise_loop_exceeded",
          reviseCount: 1,
        }).invoke,
      ).toBe(false);

      expect(
        shouldInvokeChallenger({
          config: { enabled: true },
          trigger: "revise_loop_exceeded",
          reviseCount: 2,
        }).invoke,
      ).toBe(true);
    });

    it("respects max invocations per task", () => {
      expect(
        shouldInvokeChallenger({
          config: { enabled: true, maxInvocationsPerTask: 1 },
          trigger: "architecture_conflict",
          priorChallengerCount: 1,
        }).invoke,
      ).toBe(false);
    });

    it("invokes for architecture_conflict", () => {
      const result = shouldInvokeChallenger({
        config: { enabled: true },
        trigger: "architecture_conflict",
      });
      expect(result.invoke).toBe(true);
      expect(result.reason).toBe("architecture_conflict");
    });

    it("invokes for migration_risk", () => {
      expect(
        shouldInvokeChallenger({
          config: { enabled: true },
          trigger: "migration_risk",
        }).invoke,
      ).toBe(true);
    });

    it("invokes for root_cause_ambiguity", () => {
      expect(
        shouldInvokeChallenger({
          config: { enabled: true },
          trigger: "root_cause_ambiguity",
        }).invoke,
      ).toBe(true);
    });
  });
});
