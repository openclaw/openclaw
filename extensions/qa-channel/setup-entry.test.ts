// Qa Channel tests cover setup entry plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qa-channel setup entry", () => {
  let setupPlugin: ReturnType<typeof setupEntry.loadSetupPlugin>;

  beforeAll(() => {
    setupPlugin = setupEntry.loadSetupPlugin();
  });

  it("loads the bundled setup plugin through the setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");

    expect(setupPlugin.id).toBe("qa-channel");
    expect(setupPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(
      setupPlugin.config.resolveAccount(
        {
          agents: { defaults: { mediaMaxMb: 8 } },
          channels: {
            "qa-channel": { mediaMaxMb: 2, accounts: { Limited: { mediaMaxMb: 1 / 1024 } } },
          },
        },
        "limited",
      ),
    ).toMatchObject({ accountId: "limited", mediaMaxBytes: 1024 });
  });

  it.each(["default", "named"])("updates only the selected %s account", (accountId) => {
    const cfg = {
      channels: {
        "qa-channel": {
          enabled: false,
          baseUrl: "https://root.example",
          accounts: {
            named: { enabled: false, baseUrl: "https://named.example", botUserId: "existing" },
            sibling: { baseUrl: "https://sibling.example" },
          },
        },
      },
    };
    const next = setupPlugin.setupContract?.applyAccountConfig({
      cfg,
      accountId,
      input: { baseUrl: "https://updated.example", botDisplayName: "Updated" },
    });
    const patch = { baseUrl: "https://updated.example", botDisplayName: "Updated" };
    expect(next).toMatchObject({
      channels: {
        "qa-channel": {
          enabled: false,
          ...(accountId === "default" ? patch : { baseUrl: "https://root.example" }),
          accounts: {
            named: {
              enabled: false,
              botUserId: "existing",
              ...(accountId === "named" ? patch : { baseUrl: "https://named.example" }),
            },
            sibling: { baseUrl: "https://sibling.example" },
          },
        },
      },
    });
    expect(cfg.channels["qa-channel"].baseUrl).toBe("https://root.example");
    expect(cfg.channels["qa-channel"].accounts.named.baseUrl).toBe("https://named.example");
  });
});
