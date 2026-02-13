import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { listMatrixAccountIds, resolveMatrixAccount } from "./accounts.js";

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
  it("returns default when no accounts map is present", () => {
    const cfg: CoreConfig = {
      channels: { matrix: { homeserver: "https://matrix.example.org" } },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns account IDs from accounts map", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            work: { homeserver: "https://work.example.org" },
            personal: { homeserver: "https://personal.example.org" },
          },
        },
      },
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["personal", "work"]);
  });

  it("includes account IDs from bindings", () => {
    const cfg: CoreConfig = {
      channels: { matrix: { homeserver: "https://matrix.example.org" } },
      bindings: [
        { agentId: "main", match: { channel: "matrix", accountId: "default" } },
        { agentId: "work", match: { channel: "matrix", accountId: "work-bot" } },
      ],
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["default", "work-bot"]);
  });

  it("deduplicates account IDs from config and bindings", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accounts: {
            work: { homeserver: "https://work.example.org" },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "matrix", accountId: "work" } }],
    };
    expect(listMatrixAccountIds(cfg)).toEqual(["work"]);
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

  it("merges base config with per-account overrides", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          groupPolicy: "open",
          accounts: {
            work: {
              homeserver: "https://work.example.org",
              accessToken: "tok-work",
            },
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg, accountId: "work" });
    expect(account.homeserver).toBe("https://work.example.org");
    expect(account.config.groupPolicy).toBe("open");
    expect(account.configured).toBe(true);
  });

  it("uses base config for default account", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accessToken: "tok-base",
          accounts: {
            work: {
              homeserver: "https://work.example.org",
              accessToken: "tok-work",
            },
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg, accountId: "default" });
    expect(account.homeserver).toBe("https://base.example.org");
    expect(account.configured).toBe(true);
  });

  it("does not use env vars for non-default accounts", () => {
    process.env.MATRIX_HOMESERVER = "https://env.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "tok-env";

    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            work: {
              name: "Work Bot",
            },
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg, accountId: "work" });
    // Env vars should not be applied to non-default accounts.
    expect(account.homeserver).toBeUndefined();
    expect(account.configured).toBe(false);
  });

  it("uses env vars for the default account", () => {
    process.env.MATRIX_HOMESERVER = "https://env.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "tok-env";

    const cfg: CoreConfig = {
      channels: { matrix: {} },
    };

    const account = resolveMatrixAccount({ cfg, accountId: "default" });
    expect(account.homeserver).toBe("https://env.example.org");
    expect(account.configured).toBe(true);
  });

  it("per-account enabled=false disables the account", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accounts: {
            disabled: {
              enabled: false,
              accessToken: "tok-disabled",
            },
          },
        },
      },
    };

    const account = resolveMatrixAccount({ cfg, accountId: "disabled" });
    expect(account.enabled).toBe(false);
  });
});
