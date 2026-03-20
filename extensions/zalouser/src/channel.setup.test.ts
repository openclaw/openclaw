import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { withEnvAsync } from "../../../test/helpers/extensions/env.js";
import "./zalo-js.test-mocks.js";
import { zalouserSetupPlugin } from "./channel.setup.js";

const zalouserSetupAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: zalouserSetupPlugin,
  wizard: zalouserSetupPlugin.setupWizard!,
});

describe("zalouser setup plugin", () => {
  it("builds setup status without an initialized runtime", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-setup-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          zalouserSetupAdapter.getStatus({
            cfg: {},
            accountOverrides: {},
          }),
        ).resolves.toMatchObject({
          channel: "zalouser",
          configured: false,
          statusLines: ["Zalo Personal: needs QR login"],
        });
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
