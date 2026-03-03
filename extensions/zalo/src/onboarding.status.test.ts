import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zaloOnboardingAdapter } from "./onboarding.js";

describe("zalo onboarding status", () => {
  it("treats SecretRef botToken as configured", async () => {
    const status = await zaloOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          zalo: {
            botToken: {
              source: "env",
              provider: "default",
              id: "ZALO_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });
});
