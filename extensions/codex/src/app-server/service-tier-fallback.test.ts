import { describe, expect, it } from "vitest";
import { nextCodexServiceTier, supportsCodexTurnTierOverride } from "./service-tier-fallback.js";

function failure(status = 429): Parameters<typeof nextCodexServiceTier>[1] {
  return {
    terminal: {
      kind: "failed",
      source: "prompt",
      error: Object.assign(new Error("unavailable"), { status }),
    },
    terminalTurnId: "turn-1",
    assistantTexts: [],
    toolMetas: [],
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

describe("same-model speed recovery", () => {
  it("does not send a turn-only override to an older supported server", () => {
    expect(supportsCodexTurnTierOverride("0.149.0")).toBe(false);
    expect(supportsCodexTurnTierOverride("0.151.0-alpha.1")).toBe(false);
    expect(supportsCodexTurnTierOverride("0.151.0")).toBe(true);
    expect(supportsCodexTurnTierOverride("0.153.4")).toBe(true);
    expect(supportsCodexTurnTierOverride(undefined)).toBe(false);
  });
  it("tries lower tiers before exhausting the selected model", () => {
    expect(nextCodexServiceTier("ultrafast", failure())).toBe("priority");
    expect(nextCodexServiceTier("priority", failure(503))).toBe("default");
    expect(nextCodexServiceTier("default", failure())).toBeUndefined();
  });

  it("requires a definite rejection or a completed, replay-safe native turn", () => {
    const rejected = { ...failure(), terminalTurnId: undefined };
    expect(nextCodexServiceTier("ultrafast", rejected)).toBeUndefined();
    expect(nextCodexServiceTier("ultrafast", rejected, true)).toBe("priority");
    expect(nextCodexServiceTier("ultrafast", failure(401))).toBeUndefined();
    expect(
      nextCodexServiceTier("ultrafast", { ...failure(), assistantTexts: ["partial"] }),
    ).toBeUndefined();
    expect(
      nextCodexServiceTier("ultrafast", {
        ...failure(),
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
    ).toBeUndefined();
  });
});
