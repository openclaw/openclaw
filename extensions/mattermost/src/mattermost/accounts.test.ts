import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  inspectMattermostAccount,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
} from "./accounts.js";

function config(mattermost: NonNullable<OpenClawConfig["channels"]>["mattermost"]): OpenClawConfig {
  return { channels: { mattermost } };
}

describe("Mattermost accounts", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = config({
      botToken: "tok-default",
      baseUrl: "https://chat.example.com",
      accounts: { work: { enabled: false } },
    });
    expect(listMattermostAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });

  it("inherits top-level access policy for named accounts before doctor migration", () => {
    const policy = {
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
    } satisfies NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>;
    const cfg = config({
      ...policy,
      accounts: {
        tony: { botToken: "tok-tony", baseUrl: "https://chat.example.com" },
      },
    });
    const account = resolveMattermostAccount({ cfg, accountId: "tony" });
    expect(account.config).toMatchObject(policy);
  });

  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
  };

  it("reports an account without a token as unconfigured", () => {
    const cfg = config({
      accounts: { work: { baseUrl: "https://mm.example.com", dmPolicy: "allowlist" } },
    });
    const account = inspectMattermostAccount({ cfg, accountId: "work" });
    expect(account.configured).toBe(false);
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("keeps direct account resolution strict", () => {
    expect(() =>
      resolveMattermostAccount({
        cfg: config({ botToken: unresolvedRef, baseUrl: "https://mm.example.com" }),
      }),
    ).toThrow(/unresolved SecretRef/);
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "lower-precedence-token");
    const account = inspectMattermostAccount({
      cfg: config({ botToken: unresolvedRef, baseUrl: "https://mm.example.com" }),
    });
    expect(account).toMatchObject({
      botToken: undefined,
      botTokenSource: "config",
      botTokenStatus: "configured_unavailable",
      configured: true,
    });
  });
  it("uses per-chat-type overrides before the channel and group default", () => {
    const cfg = config({
      replyToMode: "all",
      replyToModeByChatType: { direct: "first", channel: "off" },
    });
    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "direct")).toBe("first");
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
    expect(resolveMattermostReplyToMode(account, "group")).toBe("all");
  });

  it("defaults to off when replyToMode is unset", () => {
    const account = resolveMattermostAccount({ cfg: {}, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
  });
});
