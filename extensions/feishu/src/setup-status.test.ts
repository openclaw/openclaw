import { describe, expect, it } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

const feishuConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: feishuPlugin,
  wizard: feishuPlugin.setupWizard!,
});

describe("feishu setup wizard status", () => {
  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuConfigureAdapter.getStatus({
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
