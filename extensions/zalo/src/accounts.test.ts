// Zalo tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listEnabledZaloAccounts,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";

describe("resolveZaloAccount", () => {
  it("resolves account config when account key casing differs from normalized id", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            webhookUrl: "https://top.example.com",
            accounts: {
              Work: {
                name: "Work",
                webhookUrl: "https://work.example.com",
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.config.webhookUrl).toBe("https://work.example.com");
  });

  it("falls back to top-level config for named accounts without overrides", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            enabled: true,
            webhookUrl: "https://top.example.com",
            accounts: {
              work: {},
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.webhookUrl).toBe("https://top.example.com");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                botToken: "work-token",
              },
            },
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.token).toBe("work-token");
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = {
      channels: {
        zalo: {
          botToken: "default-token",
          accounts: {
            work: {
              enabled: false,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(listZaloAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZaloAccountId(cfg)).toBe("default");
    expect(listEnabledZaloAccounts(cfg).map((account) => account.accountId)).toEqual(["default"]);
  });
});

describe("zalo accounts with an unresolved SecretRef", () => {
  const cfg = {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          broken: {
            enabled: true,
            botToken: { source: "env", provider: "default", id: "OPENCLAW_TEST_MISSING_ZALO" },
          },
          healthy: { enabled: true, botToken: "zalo-healthy-token" },
        },
      },
    },
  };

  it("keeps healthy accounts visible in enumeration instead of throwing", () => {
    const accounts = listEnabledZaloAccounts(cfg);
    const broken = accounts.find((account) => account.accountId === "broken");
    const healthy = accounts.find((account) => account.accountId === "healthy");
    expect(healthy?.token).toBe("zalo-healthy-token");
    expect(broken?.tokenSource).toBe("none");
  });

  it("keeps strict resolution throwing for direct account use", () => {
    expect(() => resolveZaloAccount({ cfg, accountId: "broken" })).toThrow(/unresolved SecretRef/);
  });

  it("inspect mode reads the unresolved ref as no token", () => {
    expect(resolveZaloAccount({ cfg, accountId: "broken", mode: "inspect" }).tokenSource).toBe(
      "none",
    );
  });
});
