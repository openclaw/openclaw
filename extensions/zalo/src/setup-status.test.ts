import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { zaloPlugin } from "./channel.js";

const zaloGetStatus = createPluginSetupWizardStatus(zaloPlugin);

describe("zalo setup wizard status", () => {
  it("treats SecretRef botToken as configured", async () => {
    const status = await zaloGetStatus({
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
