import { describe, expect, it } from "vitest";
import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const EMPTY_STORE: AuthProfileStore = {
  version: 1,
  profiles: {},
};

describe("formatAuthDoctorHint", () => {
  it("guides removed qwen portal users to model studio onboarding", async () => {
    const hint = await formatAuthDoctorHint({
      store: EMPTY_STORE,
      provider: "qwen-portal",
    });

    expect(hint).toContain("openclaw onboard --auth-choice qwen-api-key");
    expect(hint).toContain("qwen-api-key-cn");
    expect(hint).not.toContain("--provider qwen");
  });
});
