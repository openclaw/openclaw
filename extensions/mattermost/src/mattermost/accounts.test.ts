// Mattermost tests cover accounts plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  inspectMattermostAccount,
  isMattermostConfigured,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
} from "./accounts.js";

describe("resolveDefaultMattermostAccountId", () => {
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          botToken: "tok-default",
          baseUrl: "https://chat.example.com",
          accounts: {
            work: {
              enabled: false,
              botToken: "tok-work",
              baseUrl: "https://work.example.com",
            },
          },
        },
      },
    };

    expect(listMattermostAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });

  it("inherits top-level access policy for named accounts before doctor migration", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["*"],
          accounts: {
            tony: {
              botToken: "tok-tony",
              baseUrl: "https://chat.example.com",
            },
          },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "tony" });

    expect(account.config.dmPolicy).toBe("open");
    expect(account.config.groupPolicy).toBe("open");
    expect(account.config.allowFrom).toEqual(["*"]);
    expect(account.config.groupAllowFrom).toEqual(["*"]);
  });
});

describe("Mattermost account SecretRef inspection", () => {
  afterEach(() => vi.unstubAllEnvs());

  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
  };

  it("reports an account without a token as unconfigured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            work: { baseUrl: "https://mm.example.com", dmPolicy: "allowlist" },
          },
        },
      },
    };
    const account = inspectMattermostAccount({ cfg, accountId: "work" });
    expect(isMattermostConfigured(account)).toBe(false);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: false,
      dmPolicy: "allowlist",
    });
  });

  it("keeps direct account resolution strict", () => {
    expect(() =>
      resolveMattermostAccount({
        cfg: {
          channels: {
            mattermost: { botToken: unresolvedRef, baseUrl: "https://mm.example.com" },
          },
        },
      }),
    ).toThrow(/unresolved SecretRef/);
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "lower-precedence-token");
    const account = inspectMattermostAccount({
      cfg: {
        channels: {
          mattermost: { botToken: unresolvedRef, baseUrl: "https://mm.example.com" },
        },
      },
    });
    expect(account).toMatchObject({
      botToken: undefined,
      botTokenSource: "config",
      botTokenStatus: "configured_unavailable",
    });
  });
});

describe("resolveMattermostReplyToMode", () => {
  it("uses per-chat-type overrides before the channel and group default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
          replyToModeByChatType: {
            direct: "first",
            channel: "off",
          },
        },
      },
    };

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
