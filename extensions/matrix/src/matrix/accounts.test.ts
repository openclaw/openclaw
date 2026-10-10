// Matrix tests cover accounts plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../env-vars.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import {
  listMatrixAccountIds,
  resolveConfiguredMatrixBotUserIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
} from "./accounts.js";
import type { MatrixStoredCredentials } from "./credentials-state.js";

const loadMatrixCredentialsMock = vi.hoisted(() =>
  vi.fn<(env?: NodeJS.ProcessEnv, accountId?: string | null) => MatrixStoredCredentials | null>(
    () => null,
  ),
);

vi.mock("./credentials-read.js", () => ({
  captureMatrixCredentialsEnv: (env: NodeJS.ProcessEnv) => env,
  loadMatrixCredentials: (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
    loadMatrixCredentialsMock(env, accountId),
  loadMatrixCredentialsAsync: async (env?: NodeJS.ProcessEnv, accountId?: string | null) =>
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

type MatrixRoomScopeKey = "groups" | "rooms";

function createMatrixAccountConfig(accessToken: string) {
  return {
    homeserver: "https://matrix.example.org",
    accessToken,
  };
}

function createMatrixTopLevelDefaultScopedEntriesConfig(scopeKey: MatrixRoomScopeKey): CoreConfig {
  return {
    channels: {
      matrix: {
        ...createMatrixAccountConfig("default-token"),
        [scopeKey]: {
          "!default-room:example.org": {
            enabled: true,
            account: "default",
          },
          "!ops-room:example.org": {
            enabled: true,
            account: "ops",
          },
          "!shared-room:example.org": {
            enabled: true,
          },
        },
        accounts: {
          ops: createMatrixAccountConfig("ops-token"),
        },
      },
    },
  } as unknown as CoreConfig;
}

function expectMatrixScopedEntries(
  cfg: CoreConfig,
  scopeKey: MatrixRoomScopeKey,
  accountId: string,
  expected: Record<string, { enabled: true; account?: string }>,
): void {
  expect(resolveMatrixAccount({ cfg, accountId }).config[scopeKey]).toEqual(expected);
}

function expectTopLevelDefaultMatrixScopedEntries(
  cfg: CoreConfig,
  scopeKey: MatrixRoomScopeKey,
): void {
  expectMatrixScopedEntries(cfg, scopeKey, "default", {
    "!default-room:example.org": {
      enabled: true,
      account: "default",
    },
    "!shared-room:example.org": {
      enabled: true,
    },
  });
  expectMatrixScopedEntries(cfg, scopeKey, "ops", {
    "!ops-room:example.org": {
      enabled: true,
      account: "ops",
    },
    "!shared-room:example.org": {
      enabled: true,
    },
  });
}

function configWithMatrix(matrix: MatrixConfig): CoreConfig {
  return { channels: { matrix } };
}

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

  it("requires userId + password when no access token is set", () => {
    const cfg = configWithMatrix({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
    });

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("marks password auth as configured when userId is present", () => {
    const cfg = configWithMatrix({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "secret",
    });

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = configWithMatrix({
      defaultAccount: "ops",
      homeserver: "https://matrix.example.org",
      accessToken: "default-token",
      accounts: {
        ops: {
          homeserver: "https://ops.example.org",
          accessToken: "ops-token",
        },
      },
    });

    const account = resolveMatrixAccount({ cfg });
    expect(account.accountId).toBe("ops");
    expect(account.homeserver).toBe("https://ops.example.org");
    expect(account.configured).toBe(true);
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

  it("honors injected env when detecting configured bot accounts", async () => {
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_USER_ID: "@main:example.org",
      MATRIX_ACCESS_TOKEN: "main-token",
      MATRIX_ALERTS_HOMESERVER: "https://matrix.example.org",
      MATRIX_ALERTS_USER_ID: "@alerts:example.org",
      MATRIX_ALERTS_ACCESS_TOKEN: "alerts-token",
    } as NodeJS.ProcessEnv;

    const cfg: CoreConfig = {
      channels: {
        matrix: {},
      },
    };

    expect(
      Array.from(
        await resolveConfiguredMatrixBotUserIds({ cfg, accountId: "ops", env }),
      ).toSorted(),
    ).toEqual(["@alerts:example.org", "@main:example.org"]);
  });

  it("falls back to stored credentials when an access-token-only account omits userId", async () => {
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

    const cfg = configWithMatrix({
      userId: "@main:example.org",
      homeserver: "https://matrix.example.org",
      accessToken: "main-token",
      accounts: {
        ops: {
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
        },
      },
    });

    expect(
      Array.from(await resolveConfiguredMatrixBotUserIds({ cfg, accountId: "default" })),
    ).toEqual(["@ops:example.org"]);
  });

  it.each([
    {
      name: "filters legacy channel-level rooms when the default account is configured at the top level",
      scopeKey: "rooms",
      createConfig: createMatrixTopLevelDefaultScopedEntriesConfig,
      expectEntries: expectTopLevelDefaultMatrixScopedEntries,
    },
  ] as const)("$name", ({ scopeKey, createConfig, expectEntries }) => {
    expectEntries(createConfig(scopeKey), scopeKey);
  });

  it.each([
    {
      name: "keeps scoped groups bound to their account even when only one account is active",
      scopeKey: "groups",
    },
  ] as const)("$name", ({ scopeKey }) => {
    const cfg = configWithMatrix({
      [scopeKey]: {
        "!default-room:example.org": {
          enabled: true,
          account: "default",
        },
        "!shared-room:example.org": {
          enabled: true,
        },
      },
      accounts: {
        ops: {
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
        },
      },
    });

    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).config[scopeKey]).toEqual({
      "!shared-room:example.org": {
        enabled: true,
      },
    });
  });

  it.each([
    {
      name: "lets an account clear inherited legacy rooms with an explicit empty map",
      scopeKey: "rooms",
    },
  ] as const)("$name", ({ scopeKey }) => {
    const cfg = configWithMatrix({
      [scopeKey]: {
        "!shared-room:example.org": {
          enabled: true,
        },
      },
      accounts: {
        ops: {
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
          [scopeKey]: {},
        },
      },
    });

    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).config[scopeKey]).toBeUndefined();
  });
});
