import { describe, expect, it } from "vitest";
import { resolveDiscordAccount, resolveDiscordMaxLinesPerMessage } from "./accounts.js";

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("merges top-level and account-scoped allowFrom for default account", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(expect.arrayContaining(["top", "default"]));
    expect(resolved.config.allowFrom).toHaveLength(2);
  });

  it("deduplicates merged allowFrom entries", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["shared-id", "top-only"],
            accounts: {
              default: { allowFrom: ["shared-id", "account-only"], token: "token-default" },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(
      expect.arrayContaining(["shared-id", "top-only", "account-only"]),
    );
    expect(resolved.config.allowFrom).toHaveLength(3);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("uses only account allowFrom when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: { allowFrom: ["work-user"], token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["work-user"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });
});

describe("resolveDiscordMaxLinesPerMessage", () => {
  it("falls back to merged root discord maxLinesPerMessage when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default" },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "default",
    });

    expect(resolved).toBe(120);
  });

  it("prefers explicit runtime discord maxLinesPerMessage over merged config", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: { maxLinesPerMessage: 55 },
      accountId: "default",
    });

    expect(resolved).toBe(55);
  });

  it("uses per-account discord maxLinesPerMessage over the root value when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              work: { token: "token-work", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "work",
    });

    expect(resolved).toBe(80);
  });
});
