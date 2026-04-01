import { describe, expect, it } from "vitest";
import {
  resolveConfiguredDiscordBotAgentIdsByBotUserId,
  resolveDiscordAccount,
  resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("prefers accounts.default.allowFrom over top-level for default account", () => {
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

    expect(resolved.config.allowFrom).toEqual(["default"]);
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

describe("resolveConfiguredDiscordBotAgentIdsByBotUserId", () => {
  it("maps the current account bot id to its explicitly owned agent", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "MTIz.abc.def" },
          },
        },
      },
      bindings: [
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "ops" },
        },
      ],
    };

    expect(
      resolveConfiguredDiscordBotAgentIdsByBotUserId({
        cfg,
        currentAccountId: "ops",
        currentBotUserId: "BOT-OPS",
      }),
    ).toEqual(new Map([["BOT-OPS", "ops-agent"]]));
  });

  it("skips accounts that do not have an explicit ownership binding", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true, model: "gpt-5" }],
      },
      channels: {
        discord: {
          accounts: {
            ops: { token: "MTIz.abc.def" },
          },
        },
      },
    };

    expect(
      resolveConfiguredDiscordBotAgentIdsByBotUserId({
        cfg,
        currentAccountId: "ops",
        currentBotUserId: "BOT-OPS",
      }).size,
    ).toBe(0);
  });

  it("fails closed when one bot user id resolves to multiple owners", () => {
    const cfg = {
      channels: {
        discord: {
          token: "MTIz.shared.token",
          accounts: {
            ops: {},
            alerts: {},
          },
        },
      },
      bindings: [
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "ops" },
        },
        {
          agentId: "alerts-agent",
          match: { channel: "discord", accountId: "alerts" },
        },
      ],
    };

    expect(
      resolveConfiguredDiscordBotAgentIdsByBotUserId({
        cfg,
        currentAccountId: "ops",
        currentBotUserId: "123",
      }).get("123"),
    ).toBeUndefined();
  });

  it("keeps the mapping when duplicate accounts resolve to the same owner", () => {
    const cfg = {
      channels: {
        discord: {
          token: "MTIz.shared.token",
          accounts: {
            ops: {},
            alerts: {},
          },
        },
      },
      bindings: [
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "ops" },
        },
        {
          agentId: "ops-agent",
          match: { channel: "discord", accountId: "alerts" },
        },
      ],
    };

    expect(
      resolveConfiguredDiscordBotAgentIdsByBotUserId({
        cfg,
        currentAccountId: "ops",
        currentBotUserId: "123",
      }).get("123"),
    ).toBe("ops-agent");
  });
});
