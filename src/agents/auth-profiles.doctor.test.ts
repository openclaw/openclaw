/**
 * Auth-profile doctor copy tests.
 * Covers provider-specific repair hints without invoking real auth flows.
 */
import { describe, expect, it } from "vitest";
import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";

describe("formatAuthDoctorHint", () => {
  it("guides legacy qwen portal oauth profiles to re-authenticate", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "qwen-portal-auth": {
            type: "oauth",
            provider: "qwen-portal",
            access: "old-access",
            refresh: "old-refresh",
            expires: 0,
          },
        },
      },
      provider: "qwen-portal",
      profileId: "qwen-portal-auth",
    });

    expect(hint).toBe(
      "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current portal token: openclaw onboard --auth-choice qwen-oauth.",
    );
  });

  it("guides github-copilot oauth profiles with an unsupported enterprise domain to re-authenticate", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "ghu_access",
            refresh: "ghr_refresh",
            expires: 0,
            enterpriseUrl: "attacker.example",
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).toBe(
      "This GitHub Copilot OAuth profile has an unsupported enterprise domain and can no longer refresh. Re-authenticate with a supported host (github.com or a *.ghe.com tenant): openclaw onboard --auth-choice github-copilot.",
    );
  });

  it("does not force reauth for a github-copilot oauth profile on a ghe.com tenant", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "ghu_access",
            refresh: "ghr_refresh",
            expires: 0,
            enterpriseUrl: "acme.ghe.com",
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).not.toContain("unsupported enterprise domain");
  });

  it("does not force reauth for a public github.com oauth profile", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "ghu_access",
            refresh: "ghr_refresh",
            expires: 0,
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).not.toContain("unsupported enterprise domain");
  });
});
