import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../api.js";
import { getAccountConfig } from "./config.js";
import { checkTwitchMessageThroughMonitor } from "./monitor-access.test-support.js";
import {
  setTwitchAccount,
  twitchSetupPlugin,
  twitchSetupWizard as wizard,
} from "./setup-surface.js";
import { makeTwitchChannelTestConfig as config } from "./test-fixtures.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

const text = vi.fn<WizardPrompter["text"]>();
const confirm = vi.fn<WizardPrompter["confirm"]>();
const prompter = { text, confirm, note: vi.fn() } as unknown as WizardPrompter;
const account: TwitchAccountConfig = {
  username: "testbot",
  accessToken: "oauth:test123",
  clientId: "test-client-id",
  channel: "#testchannel",
};
const refreshAccount = {
  ...account,
  clientSecret: "existing-secret",
  refreshToken: "existing-refresh",
};
type Config = Parameters<typeof setTwitchAccount>[0];
type TwitchConfig = NonNullable<NonNullable<Config["channels"]>["twitch"]>;
const accounts = (values: TwitchConfig["accounts"], extra: TwitchConfig = {}) =>
  config({ ...extra, accounts: values });
const configured = (id: string) => ({
  username: `${id}-bot`,
  accessToken: `oauth:${id}`,
  clientId: `${id}-client`,
  channel: `#${id}`,
});
const group = expectDefined(wizard.groupAccess, "group access setup");
type Finalize = Parameters<NonNullable<typeof wizard.finalize>>[0];

function answers(values: string[], confirmations: boolean[] = [], fallback?: boolean) {
  text.mockReset();
  confirm.mockReset();
  if (fallback !== undefined) {
    confirm.mockResolvedValue(fallback);
  }
  for (const value of values) {
    text.mockResolvedValueOnce(value);
  }
  for (const value of confirmations) {
    confirm.mockResolvedValueOnce(value);
  }
}
async function finalize(cfg: Config, accountId = "default") {
  const result = await wizard.finalize?.({
    cfg,
    accountId,
    credentialValues: {},
    runtime: {} as Finalize["runtime"],
    prompter,
    options: {},
    forceAllowFrom: false,
  });
  return result?.cfg?.channels?.twitch?.accounts;
}
function sensitive(index: number) {
  const prompt = expectDefined(text.mock.calls[index]?.[0], "sensitive prompt");
  expect(prompt).toMatchObject({ sensitive: true });
  expect(prompt).not.toHaveProperty("initialValue");
  return expectDefined(prompt.validate, "credential validator");
}
async function checkAccess(
  overrides: Partial<TwitchAccountConfig>,
  message: Partial<TwitchChatMessage> = {},
  accountId = "secondary",
) {
  const result = await checkTwitchMessageThroughMonitor({
    account: { ...account, ...overrides },
    accountId,
    message: {
      id: "message-1",
      username: "testuser",
      userId: "123456",
      message: "@testbot hello",
      channel: account.channel,
      ...message,
    },
  });
  return result.allowed;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("Twitch setup", () => {
  it.each([false, true])(
    "keeps credentials without masked prompts (refresh: %s)",
    async (refresh) => {
      answers(["testbot", "test-client-id", "#testchannel"], refresh ? [] : [true, false], refresh);
      const saved = refresh ? refreshAccount : account;
      expect((await finalize(accounts({ default: saved })))?.default).toMatchObject(saved);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
      expect(text).toHaveBeenCalledTimes(3);
      expect(text.mock.calls.some(([prompt]) => prompt.sensitive)).toBe(false);
    },
  );
  it("replaces tokens through a sensitive validated prompt", async () => {
    answers(["testbot", "oauth:test123", "test-client-id", "#testchannel"], [], false);
    expect((await finalize(accounts({ default: account })))?.default?.accessToken).toBe(
      "oauth:test123",
    );
    const validate = sensitive(1);
    expect(["", "notoauth", "oauth:goodtoken"].map(validate)).toEqual([
      "Required",
      "Token should start with 'oauth:'",
      undefined,
    ]);
  });
  it("replaces refresh credentials through sensitive prompts", async () => {
    answers(
      ["testbot", "test-client-id", "#testchannel", "secret123", "refresh123"],
      [true, true, false, false],
    );
    expect((await finalize(accounts({ default: refreshAccount })))?.default).toMatchObject({
      clientSecret: "secret123",
      refreshToken: "refresh123",
    });
    sensitive(3);
    sensitive(4);
  });
  it.each([
    ["secondary", true, "Twitch (secondary): configured"],
    ["Alerts\r\n\u001b[31m", false, "Twitch (alerts-31m): needs username, token, and clientId"],
  ] as const)("renders normalized status for %s", (accountId, isConfigured, expected) => {
    expect(
      wizard.status?.resolveStatusLines?.({
        cfg: isConfigured ? accounts({ [accountId]: account }) : {},
        accountId,
        configured: isConfigured,
      } as never),
    ).toEqual([expected]);
  });
  it("recognizes an environment-only default token without exposing it in prompts", async () => {
    const token = "oauth:environment-only";
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", token);
    const cfg = accounts({ default: { ...account, accessToken: "" } });
    expect(wizard.status?.resolveConfigured({ cfg })).toBe(true);
    const resolved = twitchSetupPlugin.config.resolveAccount(cfg, "default");
    expect(await twitchSetupPlugin.config.isConfigured?.(resolved, cfg)).toBe(true);
    answers(["env-bot", "env-client"], [true]);
    expect((await finalize(cfg))?.default).toMatchObject({
      username: "env-bot",
      accessToken: token,
      clientId: "env-client",
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
    expect(text).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([confirm.mock.calls, text.mock.calls])).not.toContain(token);
  });
  it("rejects reserved config keys", () => {
    expect(() => setTwitchAccount({}, configured("reserved"), "__proto__")).toThrow(
      "Invalid Twitch account id",
    );
    expect(Object.prototype).not.toHaveProperty("username");
  });
  it.each([
    [{ channels: { twitch: { defaultAccount: "secondary" } } }, undefined, "secondary"],
    [{}, "alerts", "alerts"],
  ] as const)("selects DM policy keys for %j / %s", (cfg, requested, id) => {
    expect(wizard.dmPolicy?.resolveConfigKeys?.(cfg, requested)).toEqual({
      policyKey: `channels.twitch.accounts.${id}.allowedRoles`,
      allowFromKey: `channels.twitch.accounts.${id}.allowFrom`,
    });
  });
  it("persists a new selected account instead of borrowing the default environment token", async () => {
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "oauth:fromenv");
    answers(["secondary-bot", "oauth:persisted", "secondary-client", "#secondary"], [], false);
    const result = await finalize(
      accounts({ default: configured("default") }, { defaultAccount: "secondary" }),
      "secondary",
    );
    expect(result).toMatchObject({
      secondary: { username: "secondary-bot", accessToken: "oauth:persisted" },
      default: { username: "default-bot" },
    });
    const validate = expectDefined(text.mock.calls[3]?.[0].validate, "channel validator");
    expect(["", "   ", "#chan"].map(validate)).toEqual(["Required", "Required", undefined]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  });
  it("updates the whitespace-username base account without mutating other accounts", () => {
    const base = { ...account, enabled: false, allowFrom: ["123456"] };
    const cfg = config({
      ...base,
      username: " ",
      accounts: { default: base, secondary: base, untouched: refreshAccount },
    });
    const before = structuredClone(cfg);
    const patch = { allowFrom: [], allowedRoles: [], requireMention: true };
    const result = group.setPolicy({ cfg, accountId: "default", policy: "disabled" });
    expect(result).toEqual({
      channels: { twitch: { ...cfg.channels.twitch, enabled: true, ...patch } },
    });
    expect(getAccountConfig(result, "default")).toMatchObject(patch);
    expect(cfg).toEqual(before);
  });
  it("does not create a missing account", () => {
    const cfg = {};
    expect(group.setPolicy({ cfg, accountId: "missing", policy: "disabled" })).toBe(cfg);
  });
  it.each([
    ["base open", "default", [], ["open"], false, undefined, true],
    ["disable IDs", "secondary", ["123456"], ["disabled"], false, [], false],
    ["IDs before roles", "secondary", ["other"], ["allowlist"], true, ["other"], false],
    [
      "no ID restoration",
      "secondary",
      ["123456"],
      ["disabled", "allowlist"],
      false,
      undefined,
      false,
    ],
  ] as const)(
    "applies %s through ingress",
    async (_name, accountId, ids, policies, isMod, expectedIds, allowed) => {
      const initial: TwitchAccountConfig = {
        ...account,
        enabled: true,
        allowFrom: [...ids],
        allowedRoles: ["all"],
      };
      let cfg: Config = config(
        accountId === "default" ? initial : { accounts: { secondary: initial } },
      );
      for (const policy of policies) {
        cfg = group.setPolicy({ cfg, accountId, policy });
      }
      const saved = expectDefined(getAccountConfig(cfg, accountId), "configured account");
      expect(saved.allowFrom).toEqual(expectedIds);
      expect(group.currentPolicy({ cfg, accountId })).toBe(policies.at(-1));
      expect(group.updatePrompt?.({ cfg, accountId })).toBe(true);
      expect(await checkAccess(saved, { isMod }, accountId)).toBe(allowed);
    },
  );
  it("reports empty roles as open without prompting for an update", () => {
    const cfg = accounts({ secondary: { ...account, allowedRoles: [] } });
    expect(group.currentPolicy({ cfg, accountId: "secondary" })).toBe("open");
    expect(group.updatePrompt?.({ cfg, accountId: "secondary" })).toBe(false);
  });
});

describe("Twitch monitor access", () => {
  it.each<[string, Partial<TwitchAccountConfig>, Partial<TwitchChatMessage>, boolean]>([
    ["mention required", {}, { message: "hello bot" }, false],
    ["missing allowlisted ID", { allowFrom: ["123456"] }, { userId: undefined }, false],
    ["wildcard without ID", { allowedRoles: ["all"] }, { userId: undefined }, true],
    ["IDs are not roles", { allowedRoles: ["moderator"] }, { userId: "moderator" }, false],
    ["empty roles", { allowedRoles: [] }, { userId: undefined }, true],
    [
      "mention before auth",
      { requireMention: true, allowedRoles: ["moderator"] },
      { message: "ordinary chat", isMod: false },
      false,
    ],
    [
      "allowlist before roles",
      { allowFrom: ["123456"], allowedRoles: ["owner"] },
      { isOwner: false },
      true,
    ],
  ])("%s", async (_name, overrides, message, allowed) => {
    expect(await checkAccess(overrides, message)).toBe(allowed);
  });
  it.each([
    ["moderator", "isMod"],
    ["owner", "isOwner"],
    ["vip", "isVip"],
    ["subscriber", "isSub"],
  ] as const)("admits only matching %s roles with or without native IDs", async (role, flag) => {
    for (const userId of ["123456", undefined]) {
      for (const matching of [false, true]) {
        expect(await checkAccess({ allowedRoles: [role] }, { userId, [flag]: matching })).toBe(
          matching,
        );
      }
    }
  });
});
