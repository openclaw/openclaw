import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { listMatrixAccountIds, resolveMatrixAccount, resolveDefaultMatrixAccountId } from "./accounts.js";

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: () => null,
  loadMatrixCredentialsForAccount: () => null,
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
  it("returns [DEFAULT_ACCOUNT_ID] when no accounts are configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok",
        },
      },
    };

    const ids = listMatrixAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("returns account IDs when accounts are configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            personal: {
              homeserver: "https://personal.example.org",
              accessToken: "tok1",
            },
            work: {
              homeserver: "https://work.example.org",
              accessToken: "tok2",
            },
          },
        },
      },
    };

    const ids = listMatrixAccountIds(cfg);
    expect(ids).toContain("personal");
    expect(ids).toContain("work");
    expect(ids).toHaveLength(2);
  });
});

describe("resolveDefaultMatrixAccountId", () => {
  it("returns DEFAULT_ACCOUNT_ID in single account mode", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok",
        },
      },
    };

    const defaultId = resolveDefaultMatrixAccountId(cfg);
    expect(defaultId).toBe("default");
  });

  it("returns first account ID when accounts are configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            work: {
              homeserver: "https://work.example.org",
              accessToken: "tok",
            },
            personal: {
              homeserver: "https://personal.example.org",
              accessToken: "tok",
            },
          },
        },
      },
    };

    const defaultId = resolveDefaultMatrixAccountId(cfg);
    // Returns first key in object (work)
    expect(defaultId).toBe("work");
  });
});

describe("resolveMatrixAccount multi-account", () => {
  it("resolves account-specific config", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            personal: {
              homeserver: "https://personal.example.org",
              userId: "@me:personal.org",
              accessToken: "personal-tok",
            },
            work: {
              homeserver: "https://work.example.org",
              userId: "@me:work.org",
              accessToken: "work-tok",
            },
          },
        },
      },
    };

    const personal = resolveMatrixAccount({ cfg, accountId: "personal" });
    expect(personal.accountId).toBe("personal");
    expect(personal.homeserver).toBe("https://personal.example.org");
    expect(personal.userId).toBe("@me:personal.org");
    expect(personal.configured).toBe(true);

    const work = resolveMatrixAccount({ cfg, accountId: "work" });
    expect(work.accountId).toBe("work");
    expect(work.homeserver).toBe("https://work.example.org");
    expect(work.userId).toBe("@me:work.org");
    expect(work.configured).toBe(true);
  });

  it("falls back to top-level config for unknown account IDs", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://fallback.example.org",
          userId: "@fallback:example.org",
          accessToken: "fallback-tok",
        },
      },
    };

    // When accounts map is not defined, falls back to legacy single account
    const account = resolveMatrixAccount({ cfg, accountId: "default" });
    expect(account.homeserver).toBe("https://fallback.example.org");
    expect(account.userId).toBe("@fallback:example.org");
  });

  it("inherits top-level config when account-specific values are missing", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://default.example.org",
          encryption: true,
          accounts: {
            work: {
              userId: "@me:work.org",
              accessToken: "work-tok",
              // homeserver and encryption inherited from top-level
            },
          },
        },
      },
    };

    const work = resolveMatrixAccount({ cfg, accountId: "work" });
    expect(work.homeserver).toBe("https://default.example.org");
    // Account inherits encryption setting from top-level
  });
});
