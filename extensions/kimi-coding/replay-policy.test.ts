import { describe, expect, it } from "vitest";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";

describe("kimi-coding replay policy", () => {
  it("disables signature preservation", () => {
    expect(KIMI_REPLAY_POLICY.preserveSignatures).toBe(false);
  });

  it("maintains stable replay policy object", () => {
    const policy1 = KIMI_REPLAY_POLICY;
    const policy2 = KIMI_REPLAY_POLICY;
    expect(policy1).toBe(policy2);
    expect(Object.keys(policy1)).toEqual(["preserveSignatures"]);
  });
});