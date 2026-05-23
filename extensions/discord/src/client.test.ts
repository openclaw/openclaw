// Discord tests cover client plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordRestClient } from "./client.js";
import type { RequestClient } from "./internal/discord.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createDiscordRestClient", () => {
  const fakeRest = {} as RequestClient;

  it("uses explicit token without resolving config token SecretRefs", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "exec",
            provider: "vault",
            id: "discord/bot-token",
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient({ cfg, token: "Bot explicit-token", rest: fakeRest });

    expect(result.token).toBe("explicit-token");
    expect(result.rest).toBe(fakeRest);
    expect(result.account.accountId).toBe("default");
  });

  it("keeps account retry config when explicit token is provided", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: {
              token: {
                source: "exec",
                provider: "vault",
                id: "discord/ops-token",
              },
              retry: {
                attempts: 7,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient({
      cfg,
      accountId: "ops",
      token: "Bot explicit-account-token",
      rest: fakeRest,
    });

    expect(result.token).toBe("explicit-account-token");
    expect(result.account.accountId).toBe("ops");
    expect(result.account.config.retry).toEqual({ attempts: 7 });
  });

  it("applies a caller timeout to a dedicated REST client", () => {
    const cfg = { channels: { discord: { token: "discord-token" } } } as OpenClawConfig;

    const result = createDiscordRestClient({ cfg, timeoutMs: 250 });

    expect(result.rest.options.timeout).toBe(250);
  });

  it("keeps the default REST timeout when apiTimeoutMs is unset", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({ cfg });

    expect(rest.options.timeout).toBe(15_000);
  });

  it("uses configured top-level REST timeout", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          apiTimeoutMs: 45_000,
        },
      },
    } as OpenClawConfig;

    const { rest, account } = createDiscordRestClient({ cfg });

    expect(account.config.apiTimeoutMs).toBe(45_000);
    expect(rest.options.timeout).toBe(45_000);
  });

  it("uses per-account REST timeout overrides", () => {
    const cfg = {
      channels: {
        discord: {
          apiTimeoutMs: 45_000,
          accounts: {
            ops: {
              token: "Bot ops-token",
              apiTimeoutMs: 60_000,
            },
          },
        },
      },
    } as OpenClawConfig;

    const { rest, account } = createDiscordRestClient({ cfg, accountId: "ops" });

    expect(account.accountId).toBe("ops");
    expect(account.config.apiTimeoutMs).toBe(60_000);
    expect(rest.options.timeout).toBe(60_000);
  });

  it("still fails closed when no explicit token is provided and config token is unresolved", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "file",
            provider: "default",
            id: "/discord/token",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => createDiscordRestClient({ cfg, rest: fakeRest })).toThrow(
      /configured for account "default" is unavailable/i,
    );
  });
});
