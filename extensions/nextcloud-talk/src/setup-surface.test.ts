import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { nextcloudTalkSetupAdapter, nextcloudTalkSetupWizard } from "./setup-surface.js";

describe("nextcloudTalk setup surface", () => {
  it("clears stored bot secret fields when switching the default account to env", () => {
    type ApplyAccountConfigContext = Parameters<
      typeof nextcloudTalkSetupAdapter.applyAccountConfig
    >[0];

    const next = nextcloudTalkSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.old.example",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        baseUrl: "https://cloud.example.com",
        useEnv: true,
      },
    } as unknown as ApplyAccountConfigContext);

    expect(next.channels?.["nextcloud-talk"]?.baseUrl).toBe("https://cloud.example.com");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("clears stored bot secret fields when the wizard switches to env", async () => {
    const credential = nextcloudTalkSetupWizard.credentials[0];
    const next = await credential.applyUseEnv?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.example.com",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });
});
