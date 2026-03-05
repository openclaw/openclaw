import { describe, it, expect, afterEach } from "vitest";
import { getActiveSkillEnvKeys } from "./env-overrides.js";

describe("getActiveSkillEnvKeys", () => {
  it("returns an empty set when no skill env overrides are active", () => {
    const keys = getActiveSkillEnvKeys();
    expect(keys.size).toBe(0);
  });
});
