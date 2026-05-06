import { describe, expect, it } from "vitest";
import { listEnabledIMessageAccounts, resolveIMessageAccount } from "./accounts.js";

describe("resolveIMessageAccount", () => {
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

describe("listEnabledIMessageAccounts", () => {
  it("skips default when it is only fallback config and a named account exists", () => {
    const accounts = listEnabledIMessageAccounts({
      channels: {
        imessage: {
          enabled: true,
          accounts: {
            "swang430-gmail-com": {
              enabled: true,
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
    } as never);

    expect(accounts.map((account) => account.accountId)).toEqual(["swang430-gmail-com"]);
  });

  it("keeps default when it has distinct runtime config", () => {
    const accounts = listEnabledIMessageAccounts({
      channels: {
        imessage: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              cliPath: "imsg-work",
              dmPolicy: "pairing",
            },
            default: {
              enabled: true,
              cliPath: "imsg-personal",
              dmPolicy: "pairing",
            },
          },
        },
      },
    } as never);

    expect(accounts.map((account) => account.accountId).toSorted()).toEqual(["default", "work"]);
  });

  it("still skips default when it only adds inherited processing settings", () => {
    const accounts = listEnabledIMessageAccounts({
      channels: {
        imessage: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              cliPath: "imsg",
              dmPolicy: "pairing",
            },
            default: {
              textChunkLimit: 2000,
              mediaMaxMb: 32,
              attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
            },
          },
        },
      },
    } as never);

    expect(accounts.map((account) => account.accountId)).toEqual(["work"]);
  });
});
