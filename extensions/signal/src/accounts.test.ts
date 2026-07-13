// Signal tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("default");
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                account: "+15555550123",
                httpUrl: "http://127.0.0.1:9999",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });

  it("treats root server fields as shared defaults when only named accounts exist", () => {
    const cfg = {
      channels: {
        signal: {
          httpUrl: "http://127.0.0.1:8080",
          autoStart: false,
          accounts: {
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["work"]);
    expect(listEnabledSignalAccounts(cfg).map((account) => account.accountId)).toEqual(["work"]);
    expect(resolveSignalAccount({ cfg, accountId: "work" })).toMatchObject({
      baseUrl: "http://127.0.0.1:8080",
      configured: true,
    });
  });

  it("keeps an explicit accountless default enumerable when named accounts coexist", () => {
    const cfg = {
      channels: {
        signal: {
          httpUrl: "http://127.0.0.1:8080",
          autoStart: false,
          accounts: {
            default: {},
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(listEnabledSignalAccounts(cfg).map((account) => account.accountId)).toEqual([
      "default",
      "work",
    ]);
    expect(resolveSignalAccount({ cfg, accountId: "default" })).toMatchObject({
      baseUrl: "http://127.0.0.1:8080",
      configured: true,
    });
  });

  it("does not infer a root account from apiMode alone", () => {
    const cfg = {
      channels: {
        signal: {
          apiMode: "native",
          accounts: {
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["work"]);
  });
});
