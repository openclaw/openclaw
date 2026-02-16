import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import {
  resolveMatrixAccount,
  resolveAccountConfig,
  mergeAccountConfig,
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  listEnabledMatrixAccounts,
} from "./accounts.js";

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: () => null,
  credentialsMatchConfig: () => false,
}));

const envKeys = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_NAME",
];

describe("resolveMatrixAccount", () => {
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    prevEnv = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = prevEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("treats access-token-only config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-access",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("requires userId + password when no access token is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("marks password auth as configured when userId is present", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });
});

describe("resolveAccountConfig", () => {
  it("returns undefined when no accounts configured", () => {
    const cfg: CoreConfig = {
      channels: { matrix: { homeserver: "https://example.org" } },
    };
    expect(resolveAccountConfig(cfg, "assistant")).toBeUndefined();
  });

  it("resolves account by direct key match", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            assistant: { homeserver: "https://a.example.org" },
            alerts: { homeserver: "https://b.example.org" },
          },
        },
      },
    };
    const result = resolveAccountConfig(cfg, "assistant");
    expect(result).toBeDefined();
    expect(result!.homeserver).toBe("https://a.example.org");
  });

  it("resolves account with case-insensitive fallback", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            Assistant: { homeserver: "https://a.example.org" },
          },
        },
      },
    };
    const result = resolveAccountConfig(cfg, "assistant");
    expect(result).toBeDefined();
    expect(result!.homeserver).toBe("https://a.example.org");
  });

  it("returns undefined for missing account", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            assistant: { homeserver: "https://a.example.org" },
          },
        },
      },
    };
    expect(resolveAccountConfig(cfg, "nonexistent")).toBeUndefined();
  });
});

describe("mergeAccountConfig", () => {
  it("merges account overrides into base config", () => {
    const base = { homeserver: "https://base.org", userId: "@base:org" };
    const account = { homeserver: "https://override.org" };
    const merged = mergeAccountConfig(base, account);
    expect(merged.homeserver).toBe("https://override.org");
    expect(merged.userId).toBe("@base:org");
  });

  it("deep-merges nested dm and actions objects", () => {
    const base = { dm: { policy: "allowlist" as const, allowFrom: ["@a:org"] } };
    const account = { dm: { allowFrom: ["@b:org"] } };
    const merged = mergeAccountConfig(base as any, account as any);
    expect((merged as any).dm.policy).toBe("allowlist");
    expect((merged as any).dm.allowFrom).toEqual(["@b:org"]);
  });

  it("strips accounts key from merged result", () => {
    const base = { accounts: { x: {} } } as any;
    const account = { homeserver: "https://a.org" };
    const merged = mergeAccountConfig(base, account);
    expect((merged as any).accounts).toBeUndefined();
  });
});

describe("listMatrixAccountIds", () => {
  it("returns default when no accounts configured", () => {
    const cfg: CoreConfig = {
      channels: { matrix: { homeserver: "https://example.org" } },
    };
    const ids = listMatrixAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("returns sorted, normalized, deduplicated account IDs", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            Claudia: { homeserver: "https://c.org" },
            alerts: { homeserver: "https://a.org" },
            CLAUDIA: { homeserver: "https://c2.org" }, // duplicate after normalization
          },
        },
      },
    };
    const ids = listMatrixAccountIds(cfg);
    expect(ids).toEqual(["alerts", "claudia"]);
  });
});

describe("resolveDefaultMatrixAccountId", () => {
  it("prefers 'default' account if present", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            default: { homeserver: "https://d.org" },
            assistant: { homeserver: "https://a.org" },
          },
        },
      },
    };
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("falls back to first sorted account if no default", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            zebra: { homeserver: "https://z.org" },
            alpha: { homeserver: "https://a.org" },
          },
        },
      },
    };
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("alpha");
  });
});

describe("resolveMatrixAccount with multi-account", () => {
  it("inherits top-level config when account has partial overrides", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.org",
          accessToken: "base-token",
          accounts: {
            alerts: { userId: "@alerts:base.org" },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "alerts" });
    expect(account.homeserver).toBe("https://base.org");
    expect(account.userId).toBe("@alerts:base.org");
  });

  it("marks disabled accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.org",
          accessToken: "tok",
          accounts: {
            disabled: { enabled: false },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "disabled" });
    expect(account.enabled).toBe(false);
  });
});

describe("listEnabledMatrixAccounts", () => {
  it("filters out disabled accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.org",
          accessToken: "tok",
          accounts: {
            active: { homeserver: "https://a.org", accessToken: "t1" },
            disabled: { enabled: false, homeserver: "https://b.org", accessToken: "t2" },
          },
        },
      },
    };
    const enabled = listEnabledMatrixAccounts(cfg);
    expect(enabled.length).toBe(1);
    expect(enabled[0].accountId).toBe("active");
  });
});
