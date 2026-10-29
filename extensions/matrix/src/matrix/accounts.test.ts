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
          "!default-room:example.org": { enabled: true, account: "default" },
          "!ops-room:example.org": { enabled: true, account: "ops" },
          "!shared-room:example.org": { enabled: true },
        },
        accounts: {
          ops: createMatrixAccountConfig("ops-token"),
        },
      },
    },
  } as unknown as CoreConfig;
}

function configWithMatrix(matrix: MatrixConfig): CoreConfig {
  return { channels: { matrix } };
}

describe("resolveMatrixAccount", () => {
  beforeEach(() => {
    loadMatrixCredentialsMock.mockReset().mockReturnValue(null);
    for (const key of envKeys) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "secret"])("requires a password for userId auth (%s)", (password) => {
    const cfg = configWithMatrix({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password,
    });
    expect(resolveMatrixAccount({ cfg }).configured).toBe(password !== undefined);
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
    expect(account).toMatchObject({
      accountId: "ops",
      homeserver: "https://ops.example.org",
      configured: true,
    });
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

    const cfg = configWithMatrix({});

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

    const cfg = configWithMatrix({});

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

  it("filters legacy channel-level rooms when the default account is configured at the top level", () => {
    const cfg = createMatrixTopLevelDefaultScopedEntriesConfig("rooms");
    expect(resolveMatrixAccount({ cfg, accountId: "default" }).config.rooms).toEqual({
      "!default-room:example.org": { enabled: true, account: "default" },
      "!shared-room:example.org": { enabled: true },
    });
    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).config.rooms).toEqual({
      "!ops-room:example.org": { enabled: true, account: "ops" },
      "!shared-room:example.org": { enabled: true },
    });
  });

  it("keeps scoped groups bound to their account even when only one account is active", () => {
    const cfg = configWithMatrix({
      groups: {
        "!default-room:example.org": { enabled: true, account: "default" },
        "!shared-room:example.org": { enabled: true },
      },
      accounts: {
        ops: {
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
        },
      },
    });

    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).config.groups).toEqual({
      "!shared-room:example.org": { enabled: true },
    });
  });

  it("lets an account clear inherited legacy rooms with an explicit empty map", () => {
    const cfg = configWithMatrix({
      rooms: { "!shared-room:example.org": { enabled: true } },
      accounts: {
        ops: {
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
          rooms: {},
        },
      },
    });

    expect(resolveMatrixAccount({ cfg, accountId: "ops" }).config.rooms).toBeUndefined();
  });
});
