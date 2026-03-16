import type { OpenClawConfig } from "openclaw/plugin-sdk/zalo";
import { describe, expect, it } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { zaloPlugin } from "./channel.js";

const zaloConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: zaloPlugin,
  wizard: zaloPlugin.setupWizard!,
});

describe("zalo setup wizard status", () => {
  it("treats SecretRef botToken as configured", async () => {
    const status = await zaloConfigureAdapter.getStatus({
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
