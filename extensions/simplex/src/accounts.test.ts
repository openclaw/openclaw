import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  listSimplexAccountIds,
  resolveDefaultSimplexAccountId,
  resolveSimplexAccount,
} from "./accounts.js";

describe("simplex accounts", () => {
  it("returns default account id when unconfigured", () => {
    const cfg = { channels: {} } as OpenClawConfig;
    expect(listSimplexAccountIds(cfg)).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  it("sorts configured account ids", () => {
    const cfg = {
      channels: {
        simplex: {
          accounts: {
            beta: {},
            alpha: {},
          },
        },
      },
    } as OpenClawConfig;
    expect(listSimplexAccountIds(cfg)).toEqual(["alpha", "beta"]);
  });

  it("resolves default account id when present", () => {
    const cfg = {
      channels: {
        simplex: {
          accounts: {
            default: {},
            alpha: {},
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveDefaultSimplexAccountId(cfg)).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("falls back to first configured account id when default missing", () => {
    const cfg = {
      channels: {
        simplex: {
          accounts: {
            gamma: {},
            beta: {},
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveDefaultSimplexAccountId(cfg)).toBe("beta");
  });

  it("merges connection config across base and account", () => {
    const cfg = {
      channels: {
        simplex: {
          enabled: true,
          connection: {
            mode: "managed",
            wsHost: "base-host",
            wsPort: 4111,
            cliPath: "/opt/simplex",
          },
          accounts: {
            alpha: {
              connection: {
                wsPort: 5225,
                dataDir: "/tmp/simplex-alpha",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = resolveSimplexAccount({ cfg, accountId: "alpha" });
    expect(account.mode).toBe("managed");
    expect(account.wsHost).toBe("base-host");
    expect(account.wsPort).toBe(5225);
    expect(account.wsUrl).toBe("ws://base-host:5225");
    expect(account.cliPath).toBe("/opt/simplex");
    expect(account.dataDir).toBe("/tmp/simplex-alpha");
    expect(account.enabled).toBe(true);
  });

  it("honors disabled flags", () => {
    const cfg = {
      channels: {
        simplex: {
          enabled: false,
          accounts: {
            alpha: {},
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveSimplexAccount({ cfg, accountId: "alpha" }).enabled).toBe(false);

    const cfg2 = {
      channels: {
        simplex: {
          enabled: true,
          accounts: {
            alpha: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveSimplexAccount({ cfg: cfg2, accountId: "alpha" }).enabled).toBe(false);
  });

  it("requires explicit wsUrl for external mode configuration", () => {
    const cfg = {
      channels: {
        simplex: {
          accounts: {
            alpha: {
              connection: {
                mode: "external",
              },
            },
            beta: {
              connection: {
                mode: "external",
                wsUrl: "ws://example.test:9999",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const alpha = resolveSimplexAccount({ cfg, accountId: "alpha" });
    expect(alpha.wsUrl).toBe("");
    expect(alpha.configured).toBe(false);

    const beta = resolveSimplexAccount({ cfg, accountId: "beta" });
    expect(beta.configured).toBe(true);
  });
});
