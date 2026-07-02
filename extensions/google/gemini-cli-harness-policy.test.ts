// Google tests cover Gemini CLI harness opt-in policy.
import { describe, expect, it } from "vitest";
import {
  GOOGLE_GEMINI_CLI_HARNESS_ENV,
  shouldEnableGoogleGeminiCliHarness,
} from "./gemini-cli-harness-policy.js";

describe("Gemini CLI harness policy", () => {
  it("keeps the deprecated Gemini CLI harness disabled by default", () => {
    expect(shouldEnableGoogleGeminiCliHarness({})).toBe(false);
    expect(shouldEnableGoogleGeminiCliHarness({ [GOOGLE_GEMINI_CLI_HARNESS_ENV]: "" })).toBe(
      false,
    );
    expect(shouldEnableGoogleGeminiCliHarness({ [GOOGLE_GEMINI_CLI_HARNESS_ENV]: "false" })).toBe(
      false,
    );
  });

  it("requires an explicit opt-in flag before registering the harness", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(shouldEnableGoogleGeminiCliHarness({ [GOOGLE_GEMINI_CLI_HARNESS_ENV]: value })).toBe(
        true,
      );
    }
  });
});
