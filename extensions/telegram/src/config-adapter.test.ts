import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { hasTelegramAccountConfig, listTelegramAccountIds } from "./account-selection.js";
import { telegramPlugin } from "./channel.js";
import { telegramSetupPlugin } from "./channel.setup.js";
import { telegramConfigAdapter } from "./config-adapter.js";

const binding = (accountId: string, channel = "telegram") => ({
  agentId: "main",
  match: { channel, accountId },
});
const deleteAccount = telegramConfigAdapter.deleteAccount;

describe("telegram account config adapter", () => {
  it.each([
    ["runtime", telegramPlugin],
    ["setup", telegramSetupPlugin],
  ])("serves and deletes accounts through the %s plugin", (_name, plugin) => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok-base", accounts: { team: { botToken: "tok-team" } } },
      },
      bindings: [binding("team"), binding("gone")],
    } as OpenClawConfig;
    expect([
      plugin.config.hasAccountConfig?.(cfg, "team"),
      plugin.config.hasAccountConfig?.(cfg, "gone"),
    ]).toEqual([true, false]);
    const next = plugin.config.deleteAccount?.({ cfg, accountId: "team" });
    expect(next?.channels?.telegram).toEqual({ botToken: "tok-base" });
    expect(next?.bindings).toBeUndefined();
    expect(plugin.config.listAccountIds(next!)).toEqual(["default"]);
  });

  it("reports an id that only a binding still names as unserved", () => {
    const cfg = {
      channels: { telegram: { accounts: { keep: { botToken: "tok-keep" } } } },
      bindings: [binding("removed"), binding("keep")],
    } as OpenClawConfig;
    expect(listTelegramAccountIds(cfg)).toEqual(["keep", "removed"]);
    expect(hasTelegramAccountConfig(cfg, "removed")).toBe(false);
    expect(hasTelegramAccountConfig(cfg, "keep")).toBe(true);
  });

  it("serves a bound id only while no named account exists and a channel token does", () => {
    const alias = (telegram: object, accountId = "alias") =>
      ({ channels: { telegram }, bindings: [binding(accountId)] }) as OpenClawConfig;
    expect(hasTelegramAccountConfig(alias({ botToken: "tok-base" }), "alias")).toBe(true);
    expect(hasTelegramAccountConfig(alias({ tokenFile: "/var/lib/openclaw/token" }), "alias")).toBe(
      true,
    );
    expect(hasTelegramAccountConfig(alias({ botToken: "tok-base" }, " Alias "), "alias")).toBe(
      true,
    );
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      expect(hasTelegramAccountConfig(alias({}), "alias")).toBe(false);
    });
  });

  it("drops named-account bindings when a delete empties the account map", () => {
    const cfg = {
      channels: { telegram: { botToken: "tok-base", accounts: { ops: { botToken: "tok-ops" } } } },
      bindings: [
        binding("ops"),
        binding(" Ops "),
        binding("earlier"),
        binding("*"),
        binding("default"),
        binding("ops", "discord"),
        {
          type: "acp",
          agentId: "main",
          match: { channel: "telegram", accountId: "ops", peer: { kind: "group", id: "-1001" } },
        },
      ],
    } as OpenClawConfig;
    const next = deleteAccount({ cfg, accountId: "ops" });
    expect(next.channels?.telegram).toEqual({ botToken: "tok-base" });
    expect(next.bindings).toEqual([binding("*"), binding("default"), binding("ops", "discord")]);
    expect(listTelegramAccountIds(next)).toEqual(["default"]);
    expect([
      hasTelegramAccountConfig(next, "ops"),
      hasTelegramAccountConfig(next, "earlier"),
    ]).toEqual([false, false]);
    expect(cfg.bindings).toHaveLength(7);
  });

  it("keeps deleted accounts refused when they are deleted one at a time", () => {
    let cfg = {
      channels: {
        telegram: {
          botToken: "tok-base",
          accounts: { a: { botToken: "a" }, b: { botToken: "b" } },
        },
      },
      bindings: [binding("a"), binding("b")],
    } as OpenClawConfig;
    cfg = deleteAccount({ cfg, accountId: "a" });
    expect(cfg.bindings).toHaveLength(2);
    expect(hasTelegramAccountConfig(cfg, "a")).toBe(false);
    cfg = deleteAccount({ cfg, accountId: "b" });
    expect(cfg.bindings).toBeUndefined();
    expect([hasTelegramAccountConfig(cfg, "a"), hasTelegramAccountConfig(cfg, "b")]).toEqual([
      false,
      false,
    ]);
  });

  it("drops them without a channel token too, so a later token cannot serve the deleted id", () => {
    const cfg = {
      channels: { telegram: { accounts: { team: { botToken: "tok-team" } } } },
      bindings: [binding("team")],
    } as OpenClawConfig;
    const next = deleteAccount({ cfg, accountId: "team" });
    expect(next.bindings).toBeUndefined();
    const withToken = {
      ...next,
      channels: { telegram: { botToken: "tok-new" } },
    } as OpenClawConfig;
    expect(hasTelegramAccountConfig(withToken, "team")).toBe(false);
  });

  it("drops them when deleting the default entry empties the account map", () => {
    let cfg = {
      channels: {
        telegram: {
          botToken: "tok-base",
          accounts: { default: { botToken: "tok-default" }, ops: { botToken: "tok-ops" } },
        },
      },
      bindings: [binding("ops")],
    } as OpenClawConfig;
    cfg = deleteAccount({ cfg, accountId: "ops" });
    expect(cfg.bindings).toEqual([binding("ops")]);
    expect(hasTelegramAccountConfig(cfg, "ops")).toBe(false);
    cfg = deleteAccount({ cfg, accountId: "default" });
    expect(cfg.bindings).toBeUndefined();
  });

  it.each([
    [
      "another named account remains",
      { accounts: { team: { botToken: "tok-team" }, keep: { botToken: "tok-keep" } } },
      "team",
    ],
    [
      "the stored key only matches after normalization",
      { accounts: { Ops: { botToken: "t" } } },
      "ops",
    ],
    ["the bound id is the single-bot alias", { botToken: "tok-base" }, "team"],
  ])("leaves bindings alone when %s", (_case, telegram, accountId) => {
    const cfg = { channels: { telegram }, bindings: [binding(accountId)] } as OpenClawConfig;
    expect(deleteAccount({ cfg, accountId }).bindings).toEqual([binding(accountId)]);
  });

  it("leaves default and single-bot alias bindings in place when the default is deleted", () => {
    const cfg = {
      channels: { telegram: { botToken: "tok-base" } },
      bindings: [binding("default"), binding("alias")],
    } as OpenClawConfig;
    expect(deleteAccount({ cfg, accountId: "default" }).bindings).toEqual([
      binding("default"),
      binding("alias"),
    ]);
  });
});
