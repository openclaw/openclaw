import { describe, expect, it } from "vitest";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";

describe("Kimi replay policy", () => {
  it("disables signature preservation", () => {
    expect(KIMI_REPLAY_POLICY.preserveSignatures).toBe(false);
  });

  it("is a stable object reference", () => {
    expect(KIMI_REPLAY_POLICY).toEqual({ preserveSignatures: false });
  });
});
