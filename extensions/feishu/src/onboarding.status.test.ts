import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it } from "vitest";
import { feishuOnboardingAdapter } from "./onboarding.js";

describe("feishu onboarding status", () => {
  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuOnboardingAdapter.getStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "cli_a123456",
            appSecret: {
              source: "env",
              provider: "default",
              id: "FEISHU_APP_SECRET",
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });
});
