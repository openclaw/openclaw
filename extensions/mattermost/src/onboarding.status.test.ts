import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { mattermostOnboardingAdapter } from "./onboarding.js";

describe("mattermost onboarding status", () => {
  it("treats SecretRef botToken as configured when baseUrl is present", async () => {
    const status = await mattermostOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.test",
            botToken: {
              source: "env",
              provider: "default",
              id: "MATTERMOST_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });
});
