import { describe, expect, it } from "vitest";
import {
  collectIMessageDuplicateAccountSourceWarnings,
  isIMessageAccountEnabledForRuntime,
  listEnabledIMessageAccounts,
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageAccountDisabledReason,
} from "./accounts.js";

describe("resolveIMessageAccount", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        imessage: {
          cliPath: "/usr/local/bin/imsg",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listIMessageAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIMessageAccountId(cfg)).toBe("default");
    expect(resolveIMessageAccount({ cfg }).config.cliPath).toBe("/usr/local/bin/imsg");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveIMessageAccount({
      cfg: {
        channels: {
          imessage: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                cliPath: "/usr/local/bin/imsg-work",
                dmPolicy: "open",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.config.cliPath).toBe("/usr/local/bin/imsg-work");
    expect(resolved.config.dmPolicy).toBe("open");
    expect(resolved.configured).toBe(true);
  });
});

describe("iMessage duplicate-source account filtering", () => {
  it("treats default and a named account that share cliPath as duplicates", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {
              cliPath: "imsg",
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            },
            default: {
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as never;

    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["swang430-gmail-com"]);

    const dupAccount = resolveIMessageAccount({ cfg, accountId: "default" });
    expect(isIMessageAccountEnabledForRuntime(dupAccount, cfg)).toBe(false);
    expect(resolveIMessageAccountDisabledReason(dupAccount, cfg)).toBe(
      'duplicate iMessage source; using account "swang430-gmail-com"',
    );

    const ownerAccount = resolveIMessageAccount({ cfg, accountId: "swang430-gmail-com" });
    expect(isIMessageAccountEnabledForRuntime(ownerAccount, cfg)).toBe(true);
    expect(resolveIMessageAccountDisabledReason(ownerAccount, cfg)).toBe("disabled");
  });

  it("keeps both accounts when they target different cliPaths", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            work: { cliPath: "/usr/local/bin/imsg-work" },
            home: { cliPath: "/usr/local/bin/imsg-home" },
          },
        },
      },
    } as never;

    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["home", "work"]);
  });

  it("does not let a disabled duplicate suppress the enabled named account", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: { enabled: false },
          },
        },
      },
    } as never;

    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["swang430-gmail-com"]);
  });

  it("emits one preview warning per collision group", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: {},
          },
        },
      },
    } as never;

    const warnings = collectIMessageDuplicateAccountSourceWarnings({ cfg });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/channels\.imessage:/);
    expect(warnings[0]).toMatch(/swang430-gmail-com/);
    expect(warnings[0]).toMatch(/"default"/);
    expect(warnings[0]).toMatch(/cliPath=imsg/);
  });

  it("emits no warning when only one account is enabled", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: { enabled: false },
          },
        },
      },
    } as never;

    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });
});
