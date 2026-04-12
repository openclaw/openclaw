import { describe, expect, it } from "vitest";
import { resolveIMessageAccount, shouldStartIMessageAccount } from "./accounts.js";

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

describe("shouldStartIMessageAccount", () => {
  it("treats default as shadowed when a named account uses the same watcher backend", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            default: {
              allowFrom: ["+15550100"],
            },
            work: {
              name: "Work",
              allowFrom: ["+15550101"],
            },
          },
        },
      },
    } as never;

    const defaultAccount = resolveIMessageAccount({ cfg, accountId: "default" });
    const workAccount = resolveIMessageAccount({ cfg, accountId: "work" });

    expect(shouldStartIMessageAccount({ cfg, account: defaultAccount })).toBe(false);
    expect(shouldStartIMessageAccount({ cfg, account: workAccount })).toBe(true);
  });

  it("keeps default enabled when the named account uses a different watcher backend", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            default: {
              allowFrom: ["+15550100"],
            },
            work: {
              cliPath: "/usr/local/bin/imsg-work",
              allowFrom: ["+15550101"],
            },
          },
        },
      },
    } as never;

    const defaultAccount = resolveIMessageAccount({ cfg, accountId: "default" });

    expect(shouldStartIMessageAccount({ cfg, account: defaultAccount })).toBe(true);
  });
});
