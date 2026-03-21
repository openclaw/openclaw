import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../env-vars.js";
import type { CoreConfig } from "../types.js";
import {
  listMatrixAccountIds,
  resolveConfiguredMatrixBotUserIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
} from "./accounts.js";
import type { MatrixStoredCredentials } from "./credentials-read.js";

const loadMatrixCredentialsMock = vi.hoisted(() =>
  vi.fn<(env?: NodeJS.ProcessEnv, accountId?: string | null) => MatrixStoredCredentials | null>(
    () => null,
  ),
);

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentials: (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
    loadMatrixCredentialsMock(env, accountId),
  credentialsMatchConfig: () => false,
}));

const envKeys = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_NAME",
  "MATRIX_DEFAULT_HOMESERVER",
  "MATRIX_DEFAULT_ACCESS_TOKEN",
  getMatrixScopedEnvVarNames("team-ops").homeserver,
  getMatrixScopedEnvVarNames("team-ops").accessToken,
];

describe("resolveMatrixAccount", () => {
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    loadMatrixCredentialsMock.mockReset().mockReturnValue(null);
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

  it("normalizes and de-duplicates configured account ids", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          defaultAccount: "Main Bot",
          accounts: {
            "Main Bot": {
              homeserver: "https://matrix.example.org",
              accessToken: "main-token",
            },
            "main-bot": {
              homeserver: "https://matrix.example.org",
              accessToken: "duplicate-token",
            },
            OPS: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["main-bot", "ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("main-bot");
  });

  it("returns the only named account when no explicit default is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("ops");
  });

  it("includes env-backed named accounts in plugin account enumeration", () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    process.env[keys.homeserver] = "https://matrix.example.org";
    process.env[keys.accessToken] = "ops-token";

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["team-ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("team-ops");
  });

  it("includes default accounts backed only by global env vars in plugin account enumeration", () => {
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "default-token";

    const cfg: CoreConfig = {};

    expect(listMatrixAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("treats mixed default and named env-backed accounts as multi-account", () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    process.env.MATRIX_HOMESERVER = "https://matrix.example.org";
    process.env.MATRIX_ACCESS_TOKEN = "default-token";
    process.env[keys.homeserver] = "https://matrix.example.org";
    process.env[keys.accessToken] = "ops-token";

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(listMatrixAccountIds(cfg)).toEqual(["default", "team-ops"]);
    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it('uses the synthetic "default" account when multiple named accounts need explicit selection', () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          accounts: {
            alpha: {
              homeserver: "https://matrix.example.org",
              accessToken: "alpha-token",
            },
            beta: {
              homeserver: "https://matrix.example.org",
              accessToken: "beta-token",
            },
          },
        },
      },
    };

    expect(resolveDefaultMatrixAccountId(cfg)).toBe("default");
  });

  it("collects other configured Matrix account user ids for bot detection", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          userId: "@main:example.org",
          homeserver: "https://matrix.example.org",
          accessToken: "main-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
            },
            alerts: {
              homeserver: "https://matrix.example.org",
              userId: "@alerts:example.org",
              accessToken: "alerts-token",
            },
          },
        },
      },
    };

    expect(
      Array.from(resolveConfiguredMatrixBotUserIds({ cfg, accountId: "ops" })).toSorted(),
    ).toEqual(["@alerts:example.org", "@main:example.org"]);
  });

  it("falls back to stored credentials when an access-token-only account omits userId", () => {
    loadMatrixCredentialsMock.mockImplementation(
      (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
        accountId === "ops"
          ? {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              createdAt: "2026-03-19T00:00:00.000Z",
            }
          : null,
    );

    const cfg: CoreConfig = {
      channels: {
        matrix: {
          userId: "@main:example.org",
          homeserver: "https://matrix.example.org",
          accessToken: "main-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    };

    expect(Array.from(resolveConfiguredMatrixBotUserIds({ cfg, accountId: "default" }))).toEqual([
      "@ops:example.org",
    ]);
  });
});
