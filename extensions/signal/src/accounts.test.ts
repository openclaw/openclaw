// Signal tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
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

  it("does not treat UUID-only accounts as transport-configured", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    expect(resolved.configured).toBe(false);
  });

  it("does not add a top-level UUID-only default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          accounts: {
            work: { account: "+15555550123" },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("work");
  });

  it("does not inherit the root account UUID into named accounts with a different account", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            account: "+15555550000",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            accounts: {
              work: { account: "+15555550123" },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    expect(resolved.config.accountUuid).toBeUndefined();
  });

  it("does not inherit the root account UUID into a default account override with a different account", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            account: "+15555550000",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            accounts: {
              default: { account: "+15555550123" },
            },
          },
        },
      } as never,
      accountId: "default",
    });

    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.config.accountUuid).toBeUndefined();
  });

  it("inherits the root account UUID into named accounts that inherit the root account", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            accounts: {
              work: { name: "Work" },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.config.accountUuid).toBe("123e4567-e89b-12d3-a456-426614174000");
  });
});
