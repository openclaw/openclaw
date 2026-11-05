import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";

const makePlugin = () => createDiscordPluginBase({ setupContract: {} as never });
const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createDiscordPluginBase", () => {
  it("owns Discord native command name overrides", () => {
    const resolve = makePlugin().commands?.resolveNativeCommandName;
    expect(resolve?.({ commandKey: "tts", defaultName: "tts" })).toBe("voice");
    expect(resolve?.({ commandKey: "status", defaultName: "status" })).toBe("status");
    expect(resolve?.({ commandKey: "login", defaultName: "login" })).toBe("login");
  });

  it("reports duplicate-token accounts as disabled to gateway startup", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "same-token");
    const plugin = makePlugin();
    const cfg = config({ accounts: { work: { token: "same-token" } } });

    const defaultAccount = plugin.config.resolveAccount(cfg, "default");
    const workAccount = plugin.config.resolveAccount(cfg, "work");

    expect(plugin.config.isEnabled?.(defaultAccount, cfg)).toBe(false);
    expect(plugin.config.disabledReason?.(defaultAccount, cfg)).toBe(
      'duplicate bot token; using account "work"',
    );
    expect(plugin.config.isEnabled?.(workAccount, cfg)).toBe(true);
  });

  it("describes unresolved SecretRef tokens as startup-configured so startup reports the resolver error", () => {
    const plugin = makePlugin();
    const cfg = config({ token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" } });

    const account = plugin.config.resolveAccount(cfg, "default");
    const described = plugin.config.describeAccount?.(account, cfg);

    expect(account).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    });
    expect(plugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(described).toMatchObject({ configured: true, tokenStatus: "configured_unavailable" });
  });
});

describe("discordConfigAdapter", () => {
  it("ignores retired nested dm.allowFrom", () => {
    const cfg = {
      channels: { discord: { accounts: { default: { dm: { allowFrom: ["456"] } } } } },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([]);
  });

  it("keeps read-only accessors from resolving token SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          discord_token: {
            source: "file",
            path: "/tmp/openclaw-missing-discord-token",
            mode: "singleValue",
          },
        },
      },
      channels: {
        discord: {
          token: { source: "file", provider: "discord_token", id: "value" },
          allowFrom: ["1128540374256849009"],
          defaultTo: "1498959610751750304",
        },
      },
    } as OpenClawConfig;

    expect(discordConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "1128540374256849009",
    ]);
    expect(discordConfigAdapter.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "1498959610751750304",
    );
  });
});
