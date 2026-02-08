import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  mergeMatrixAccountConfig,
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

describe("listMatrixAccountIds", () => {
  it("returns [default] when no accounts are configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok",
        },
      },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns [default] when accounts is empty", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {},
        },
      },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns configured account IDs sorted alphabetically", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            poly: {
              homeserver: "https://poly.example.org",
              accessToken: "tok-poly",
              userId: "@poly:example.org",
            },
            argos: {
              homeserver: "https://argos.example.org",
              accessToken: "tok-argos",
              userId: "@argos:example.org",
            },
          },
        },
      },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["argos", "poly"]);
  });

  it("returns [default] when channels.matrix is undefined", () => {
    const cfg: CoreConfig = {};
    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
  });

  it("filters out empty string keys", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            "": { homeserver: "https://empty.example.org" },
            poly: { homeserver: "https://poly.example.org" },
          },
        },
      },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["poly"]);
  });
});

describe("resolveDefaultMatrixAccountId", () => {
  it("returns default when no accounts configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    };
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("returns first alphabetical account when default is not in the list", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            zebra: { homeserver: "https://z.example.org" },
            alpha: { homeserver: "https://a.example.org" },
          },
        },
      },
    };
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("alpha");
  });

  it("returns default when default is explicitly in accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            default: { homeserver: "https://d.example.org" },
            poly: { homeserver: "https://p.example.org" },
          },
        },
      },
    };
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });
});

describe("mergeMatrixAccountConfig", () => {
  it("returns base config when no account overrides exist", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "base-tok",
        },
      },
    };
    const merged = mergeMatrixAccountConfig(cfg, "default");
    expect(merged.homeserver).toBe("https://matrix.example.org");
    expect(merged.userId).toBe("@bot:example.org");
    expect(merged.accessToken).toBe("base-tok");
    // accounts field should be stripped
    expect((merged as any).accounts).toBeUndefined();
  });

  it("merges account overrides over base config", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "base-tok",
          accounts: {
            poly: {
              homeserver: "https://poly.example.org",
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const merged = mergeMatrixAccountConfig(cfg, "poly");
    expect(merged.homeserver).toBe("https://poly.example.org");
    expect(merged.userId).toBe("@poly:example.org");
    expect(merged.accessToken).toBe("poly-tok");
  });

  it("inherits base fields not overridden by account", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "base-tok",
          encryption: true,
          mediaMaxMb: 50,
          accounts: {
            poly: {
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const merged = mergeMatrixAccountConfig(cfg, "poly");
    // Overridden
    expect(merged.accessToken).toBe("poly-tok");
    expect(merged.userId).toBe("@poly:example.org");
    // Inherited from base
    expect(merged.homeserver).toBe("https://matrix.example.org");
    expect(merged.encryption).toBe(true);
    expect(merged.mediaMaxMb).toBe(50);
  });
});

describe("resolveMatrixAccount multi-account", () => {
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

  it("resolves a named account as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            poly: {
              homeserver: "https://poly.example.org",
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "poly" });
    expect(account.configured).toBe(true);
    expect(account.accountId).toBe("poly");
    expect(account.homeserver).toBe("https://poly.example.org");
    expect(account.userId).toBe("@poly:example.org");
  });

  it("named account inherits homeserver from base when not overridden", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            poly: {
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "poly" });
    expect(account.configured).toBe(true);
    expect(account.homeserver).toBe("https://matrix.example.org");
  });

  it("disabled account is not enabled", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            poly: {
              enabled: false,
              homeserver: "https://poly.example.org",
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "poly" });
    expect(account.enabled).toBe(false);
  });

  it("globally disabled matrix disables all accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          enabled: false,
          homeserver: "https://matrix.example.org",
          accounts: {
            poly: {
              homeserver: "https://poly.example.org",
              accessToken: "poly-tok",
              userId: "@poly:example.org",
            },
          },
        },
      },
    };
    const account = resolveMatrixAccount({ cfg, accountId: "poly" });
    expect(account.enabled).toBe(false);
  });

  it("backward compatible: single account config still works", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok",
          userId: "@bot:example.org",
        },
      },
    };
    const ids = listMatrixAccountIds(cfg);
    expect(ids).toEqual(["default"]);
    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
    expect(account.accountId).toBe("default");
    expect(account.homeserver).toBe("https://matrix.example.org");
  });
});
