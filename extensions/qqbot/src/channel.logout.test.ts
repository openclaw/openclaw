import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./bridge/config.js";
import { setQQBotRuntime } from "./bridge/runtime.js";
import { qqbotPlugin } from "./channel.js";

function createRuntime(): {
  runtime: PluginRuntime;
  replaceConfigFile: ReturnType<typeof vi.fn>;
} {
  const replaceConfigFile = vi.fn(async () => ({
    previousHash: "before",
    persistedHash: "after",
    persistedConfig: {},
    postWrite: { action: "noop" },
  }));
  const runtime = {
    version: "test",
    config: { replaceConfigFile },
  } as unknown as PluginRuntime;
  return { runtime, replaceConfigFile };
}

describe("qqbotPlugin gateway.logoutAccount", () => {
  beforeEach(() => {
    setQQBotRuntime(createRuntime().runtime);
  });

  it("marks removed credential-only named accounts as explicit logout writes", async () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            work: {
              clientSecret: "secret",
            },
          },
        },
      },
    } as OpenClawConfig;
    const { runtime, replaceConfigFile } = createRuntime();
    setQQBotRuntime(runtime);

    const result = await qqbotPlugin.gateway?.logoutAccount?.({
      accountId: "work",
      cfg,
      account: resolveQQBotAccount(cfg, "work"),
      runtime: createRuntimeEnv(),
    });

    expect(result).toMatchObject({ ok: true, cleared: true, loggedOut: true });
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        channels: {
          qqbot: {
            accounts: {},
          },
        },
      },
      writeOptions: {
        explicitSetPaths: expect.arrayContaining([
          ["channels", "qqbot", "accounts", "work"],
          ["channels", "qqbot", "accounts", "work", "clientSecret"],
        ]),
      },
      afterWrite: { mode: "auto" },
    });
  });

  it("marks removed credential-only default account blocks as explicit logout writes", async () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            default: {
              clientSecret: "secret",
            },
          },
        },
      },
    } as OpenClawConfig;
    const { runtime, replaceConfigFile } = createRuntime();
    setQQBotRuntime(runtime);

    const result = await qqbotPlugin.gateway?.logoutAccount?.({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
      account: resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID),
      runtime: createRuntimeEnv(),
    });

    expect(result).toMatchObject({ ok: true, cleared: true, loggedOut: true });
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        channels: {
          qqbot: {
            accounts: {},
          },
        },
      },
      writeOptions: {
        explicitSetPaths: expect.arrayContaining([
          ["channels", "qqbot", "accounts", DEFAULT_ACCOUNT_ID],
          ["channels", "qqbot", "accounts", DEFAULT_ACCOUNT_ID, "clientSecret"],
        ]),
      },
      afterWrite: { mode: "auto" },
    });
  });
});
