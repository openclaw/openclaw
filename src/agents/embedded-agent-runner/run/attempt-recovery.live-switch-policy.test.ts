import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../live-model-switch-error.js";
import * as liveModelSwitch from "../../live-model-switch.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("live switch fallback consent", () => {
  it.each([
    { current: "configured" as const, next: undefined, changed: true },
    { current: undefined, next: "configured" as const, changed: true },
    { current: "configured" as const, next: "configured" as const, changed: false },
  ])(
    "reports consent $current -> $next as changed=$changed to the retry owner",
    async ({ current, next, changed }) => {
      // The pending session row withdrew, granted, or kept the opt-in during an output-free attempt.
      vi.spyOn(liveModelSwitch, "shouldSwitchToLiveModel").mockResolvedValue({
        provider: "backup",
        model: "healthy",
        modelFallbackPolicy: next,
      });
      vi.spyOn(liveModelSwitch, "clearLiveModelSwitchPending").mockResolvedValue();
      const error = await recoverAfterTransportDrop({
        modelFallbackPolicy: current,
        replaySafe: true,
        canRestartForLiveSwitch: true,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LiveSessionModelSwitchError);
      expect(error).toMatchObject({
        modelFallbackPolicy: next,
        modelFallbackPolicyChanged: changed,
      });
    },
  );
});
