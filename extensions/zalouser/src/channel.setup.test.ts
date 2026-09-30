// Zalouser tests cover channel.setup plugin behavior.
import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import "./zalo-js.test-mocks.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

const zalouserSetupGetStatus = createPluginSetupWizardStatus(zalouserSetupPlugin);

describe("zalouser setup plugin", () => {
  it("exposes config-promotion declarations on the setup adapter", () => {
    expect(zalouserSetupPlugin.setupContract.singleAccountKeysToMove).toEqual([]);
  });

  it("builds setup status without an initialized runtime", async () => {
    const status = await zalouserSetupGetStatus({
      cfg: {},
      accountOverrides: {},
    });
    expect(status.channel).toBe("zalouser");
    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["Zalo Personal: needs QR login"]);
  });
});
