import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { withEnv } from "../../../src/test-utils/env.js";
import {
  listTelegramAccountIds,
  resetMissingDefaultWarnFlag,
  resolveTelegramPollActionGateState,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

function warningLines(): string[] {
  return warnMock.mock.calls.map(([line]) => String(line));
}

vi.mock("../../../src/logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn: warnMock,
      child: () => logger,
    };
    return logger;
  },
}));

describe("resolveTelegramAccount", () => {
  afterEach(() => {
    warnMock.mockClear();
    resetMissingDefaultWarnFlag();
  });

  it("falls back to the first configured account when accountId is omitted", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("work");
      expect(account.token).toBe("tok-work");
      expect(account.tokenSource).toBe("config");
    });
  });

  it("uses TELEGRAM_BOT_TOKEN when default account config is missing", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-env");
      expect(account.tokenSource).toBe("env");
    });
  });

  it("prefers default config token over TELEGRAM_BOT_TOKEN", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { botToken: "tok-config" },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-config");
      expect(account.tokenSource).toBe("config");
    });
  });

  it("does not fall back when accountId is explicitly provided", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg, accountId: "default" });
      expect(account.accountId).toBe("default");
      expect(account.tokenSource).toBe("none");
      expect(account.token).toBe("");
    });
  });

  it("formats debug logs with inspect-style output when debug env is enabled", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "", OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS: "1" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      expect(listTelegramAccountIds(cfg)).toEqual(["work"]);
      resolveTelegramAccount({ cfg, accountId: "work" });
    });

    const lines = warnMock.mock.calls.map(([line]) => String(line));
    expect(lines).toContain("listTelegramAccountIds [ 'work' ]");
    expect(lines).toContain("resolve { accountId: 'work', enabled: true, tokenSource: 'config' }");
  });
});

describe("resolveDefaultTelegramAccountId", () => {
  beforeEach(() => {
    resetMissingDefaultWarnFlag();
  });

  afterEach(() => {
    warnMock.mockClear();
    resetMissingDefaultWarnFlag();
  });

  it("warns when accounts.default is missing in multi-account setup (#32137)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { work: { botToken: "tok-work" }, alerts: { botToken: "tok-alerts" } },
        },
      },
    };

    const result = resolveDefaultTelegramAccountId(cfg);
    expect(result).toBe("alerts");
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("accounts.default is missing"));
  });

  it("does not warn when accounts.default exists", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expect(warningLines().every((line) => !line.includes("accounts.default is missing"))).toBe(
      true,
    );
  });

  it("does not warn when defaultAccount is explicitly set", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: { work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expect(warningLines().every((line) => !line.includes("accounts.default is missing"))).toBe(
      true,
    );
  });

  it("does not warn when only one non-default account is configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { work: { botToken: "tok-work" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    expect(warningLines().every((line) => !line.includes("accounts.default is missing"))).toBe(
      true,
    );
  });

  it("warns only once per process lifetime", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { work: { botToken: "tok-work" }, alerts: { botToken: "tok-alerts" } },
        },
      },
    };

    resolveDefaultTelegramAccountId(cfg);
    resolveDefaultTelegramAccountId(cfg);
    resolveDefaultTelegramAccountId(cfg);

    const missingDefaultWarns = warningLines().filter((line) =>
      line.includes("accounts.default is missing"),
    );
    expect(missingDefaultWarns).toHaveLength(1);
  });

  it("prefers channels.telegram.defaultAccount when it matches a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("work");
  });

  it("normalizes channels.telegram.defaultAccount before lookup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "Router D",
          accounts: { "router-d": { botToken: "tok-work" } },
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("router-d");
  });

  it("falls back when channels.telegram.defaultAccount is not configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "missing",
          accounts: { default: { botToken: "tok-default" }, work: { botToken: "tok-work" } },
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("default");
  });
});

describe("resolveTelegramAccount allowFrom precedence", () => {
  it("prefers accounts.default allowlists over top-level for default account", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
            accounts: {
              default: {
                botToken: "123:default",
                allowFrom: ["default"],
                groupAllowFrom: ["default-group"],
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
    expect(resolved.config.groupAllowFrom).toEqual(["default-group"]);
  });

  it("falls back to top-level allowlists for named account without overrides", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
            accounts: {
              work: { botToken: "123:work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
    expect(resolved.config.groupAllowFrom).toEqual(["top-group"]);
  });

  it("does not inherit default account allowlists for named account when top-level is absent", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "123:default",
                allowFrom: ["default"],
                groupAllowFrom: ["default-group"],
              },
              work: { botToken: "123:work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.groupAllowFrom).toBeUndefined();
  });
});

describe("resolveTelegramPollActionGateState", () => {
  it("requires both sendMessage and poll actions", () => {
    const state = resolveTelegramPollActionGateState((key) => key !== "poll");
    expect(state).toEqual({
      sendMessageEnabled: true,
      pollEnabled: false,
      enabled: false,
    });
  });

  it("returns enabled only when both actions are enabled", () => {
    const state = resolveTelegramPollActionGateState(() => true);
    expect(state).toEqual({
      sendMessageEnabled: true,
      pollEnabled: true,
      enabled: true,
    });
  });
});

describe("resolveTelegramAccount groups inheritance (#30673)", () => {
  const createMultiAccountGroupsConfig = (): OpenClawConfig => ({
    channels: {
      telegram: {
        groups: { "-100123": { requireMention: false } },
        accounts: {
          default: { botToken: "123:default" },
          dev: { botToken: "456:dev" },
        },
      },
    },
  });

  const createDefaultAccountGroupsConfig = (includeDevAccount: boolean): OpenClawConfig => ({
    channels: {
      telegram: {
        groups: { "-100999": { requireMention: true } },
        accounts: {
          default: {
            botToken: "123:default",
            groups: { "-100123": { requireMention: false } },
          },
          ...(includeDevAccount ? { dev: { botToken: "456:dev" } } : {}),
        },
      },
    },
  });

  it("inherits channel-level groups in single-account setup", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            groups: { "-100123": { requireMention: false } },
            accounts: {
              default: { botToken: "123:default" },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("does NOT inherit channel-level groups to secondary account in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      cfg: createMultiAccountGroupsConfig(),
      accountId: "dev",
    });

    expect(resolved.config.groups).toBeUndefined();
  });

  it("does NOT inherit channel-level groups to default account in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      cfg: createMultiAccountGroupsConfig(),
      accountId: "default",
    });

    expect(resolved.config.groups).toBeUndefined();
  });

  it("uses account-level groups even in multi-account setup", () => {
    const resolved = resolveTelegramAccount({
      cfg: createDefaultAccountGroupsConfig(true),
      accountId: "default",
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("account-level groups takes priority over channel-level in single-account setup", () => {
    const resolved = resolveTelegramAccount({
      cfg: createDefaultAccountGroupsConfig(false),
      accountId: "default",
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });
});
