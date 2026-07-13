// Signal tests cover setup entry plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";
import * as setupPluginApi from "./setup-plugin-api.js";

const setupEntryLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    if (/[\\/]setup-plugin-api\.[jt]s$/u.test(specifier)) {
      return setupPluginApi;
    }
    throw new Error(`unexpected setup entry module load: ${specifier}`);
  }) as never,
};

describe("signal setup entry", () => {
  it("loads the bundled setup plugin through the setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");

    const setupPlugin = setupEntry.loadSetupPlugin(setupEntryLoadOptions);
    expect(setupPlugin.id).toBe("signal");
  });

  it("keeps account-scoped config mutation helpers on the setup plugin", () => {
    const setupPlugin = setupEntry.loadSetupPlugin(setupEntryLoadOptions);
    const cfg = {
      channels: {
        signal: {
          enabled: true,
          accounts: {
            default: { account: "+15555550123" },
            work: { account: "+15555550124" },
          },
        },
      },
    } as OpenClawConfig;

    const disabled = setupPlugin.config.setAccountEnabled?.({
      cfg,
      accountId: "work",
      enabled: false,
    });
    expect(disabled?.channels?.signal?.enabled).toBe(true);
    expect(disabled?.channels?.signal?.accounts?.work?.enabled).toBe(false);

    const deleted = setupPlugin.config.deleteAccount?.({
      cfg,
      accountId: "work",
    });
    expect(deleted?.channels?.signal?.enabled).toBe(true);
    expect(deleted?.channels?.signal?.accounts?.default).toMatchObject({
      account: "+15555550123",
    });
    expect(deleted?.channels?.signal?.accounts?.work).toBeUndefined();
  });
});
