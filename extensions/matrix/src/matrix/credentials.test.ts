// Matrix tests cover SQLite-backed credentials behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasAnyMatrixAuth } from "../../auth-presence.js";
import { getMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { resolveConfiguredMatrixBotUserIds } from "./accounts.js";
import { loadMatrixCredentialsAsync, openMatrixCredentialsStore } from "./credentials-read.js";
import {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

type MatrixCredentials = NonNullable<ReturnType<typeof loadMatrixCredentials>>;

function expectMatrixCredentials(
  credentials: ReturnType<typeof loadMatrixCredentials>,
): MatrixCredentials {
  if (credentials === null) {
    throw new Error("Expected Matrix credentials");
  }
  expect(typeof credentials.createdAt).toBe("string");
  return credentials;
}

describe("matrix credentials storage", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-creds-"));
    installMatrixTestRuntime({ stateDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("roundtrips account-scoped credentials through shared plugin-state SQLite", async () => {
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
        deviceId: "DEVICE123",
      },
      {},
      "ops",
    );

    expect(loadMatrixCredentials({}, "ops")).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      deviceId: "DEVICE123",
    });
    await expect(loadMatrixCredentialsAsync({}, "ops")).resolves.toEqual(
      loadMatrixCredentials({}, "ops"),
    );
    expect(loadMatrixCredentials({}, "default")).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "credentials", "matrix"))).toBe(false);
  });

  it.each([
    { platform: "win32", mixedCase: true, expected: ["@alerts:example.org", "@main:example.org"] },
    { platform: "linux", mixedCase: true, expected: [] },
    { platform: "linux", mixedCase: false, expected: ["@alerts:example.org", "@main:example.org"] },
  ] as const)(
    "keeps $platform mixedCase=$mixedCase bot discovery on its captured credential source",
    async ({ platform, mixedCase, expected }) => {
      for (const [accountId, userId] of [
        ["default", "@main:example.org"],
        ["alerts", "@alerts:example.org"],
      ] as const) {
        await saveMatrixCredentials(
          {
            homeserver: "https://matrix.example.org",
            userId,
            accessToken: "synthetic-token",
          },
          { OPENCLAW_STATE_DIR: stateDir },
          accountId,
        );
      }
      const values = {
        Matrix_Homeserver: "https://matrix.example.org",
        Matrix_Access_Token: "synthetic-token",
        Matrix_Alerts_Homeserver: "https://matrix.example.org",
        Matrix_Alerts_Access_Token: "synthetic-token",
        OpenClaw_State_Dir: stateDir,
        OpenClaw_Supervisor_Mode: "internal",
      };
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [mixedCase ? key : key.toUpperCase(), value]),
      );
      if (platform === "win32" && mixedCase) {
        // Windows lookups ignore casing without changing the enumerated key spelling.
        for (const key of Object.keys(env)) {
          Object.defineProperty(env, key.toUpperCase(), {
            get: () => env[key],
            set: (value: string | undefined) => {
              env[key] = value;
            },
          });
        }
      }
      const runtime = getMatrixRuntime();
      vi.spyOn(runtime.state, "resolveStateDir").mockImplementation((input) =>
        input?.OPENCLAW_STATE_DIR ? resolveStateDir(input) : stateDir,
      );
      const openStore = runtime.state.openKeyedStore.bind(runtime.state);
      const observedSources: Array<{ root: string | undefined; supervisor: string | undefined }> =
        [];
      vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
        <T>(options: Parameters<typeof runtime.state.openKeyedStore>[0]) => {
          observedSources.push({
            root: options.env?.OPENCLAW_STATE_DIR,
            supervisor: options.env?.OPENCLAW_SUPERVISOR_MODE,
          });
          const store = openStore<T>(options);
          const lookup = store.lookup.bind(store);
          return {
            ...store,
            lookup: async (key) => {
              const value = await lookup(key);
              env.OPENCLAW_STATE_DIR = path.join(stateDir, "replacement");
              env.OPENCLAW_SUPERVISOR_MODE = "external";
              env.MATRIX_ALERTS_ACCESS_TOKEN = "replacement-token";
              return value;
            },
          };
        },
      );

      const ids = await resolveConfiguredMatrixBotUserIds({
        cfg: { channels: { matrix: { accounts: { alerts: {} } } } },
        accountId: "ops",
        env,
      });
      expect([...ids].toSorted()).toEqual(expected);
      expect(observedSources).toEqual([
        { root: stateDir, supervisor: mixedCase && platform === "linux" ? undefined : "internal" },
        { root: stateDir, supervisor: mixedCase && platform === "linux" ? undefined : "internal" },
      ]);
      expect(fs.existsSync(path.join(stateDir, "replacement"))).toBe(false);
    },
  );

  it("touch updates lastUsedAt while preserving createdAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
      },
      {},
      "default",
    );
    const initial = expectMatrixCredentials(loadMatrixCredentials({}, "default"));

    vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
    await touchMatrixCredentials({}, "default");
    const touched = expectMatrixCredentials(loadMatrixCredentials({}, "default"));

    expect(touched.createdAt).toBe(initial.createdAt);
    expect(touched.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
  });

  it("omits an explicitly undefined device id from persisted credentials", async () => {
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      deviceId: undefined,
    };

    await saveMatrixCredentials(credentials, {}, "default");
    await expect(saveBackfilledMatrixDeviceId(credentials, {}, "ops")).resolves.toBe("saved");

    expect(openMatrixCredentialsStore({}).lookup("account:default")).not.toHaveProperty("deviceId");
    expect(openMatrixCredentialsStore({}).lookup("account:ops")).not.toHaveProperty("deviceId");
  });

  it("backfills a matching device id but preserves newer auth lineage", async () => {
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-new",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-new",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("saved");
    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-old",
          deviceId: "STALE",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");

    expect(loadMatrixCredentials({}, "default")).toMatchObject({
      accessToken: "tok-new",
      deviceId: "DEVICE123",
    });
  });

  it.each(["before", "during comparison"])(
    "does not let delayed background writes undo credential revocation %s",
    async (timing) => {
      await saveMatrixCredentials(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "secret-token",
        },
        {},
        "default",
      );
      if (timing === "before") {
        clearMatrixCredentials({}, "default");
      } else {
        const runtime = getMatrixRuntime();
        const openStore = runtime.state.openKeyedStore.bind(runtime.state);
        let revoked = false;
        vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
          <T>(options: OpenAsyncKeyedStoreOptions) => {
            const store = openStore<T>(options);
            if (store.compareAndApply) {
              const compare = store.compareAndApply.bind(store);
              store.compareAndApply = async (...args) => {
                if (!revoked) {
                  revoked = true;
                  clearMatrixCredentials({}, "default");
                }
                return await compare(...args);
              };
            }
            return store;
          },
        );
      }

      await expect(
        saveBackfilledMatrixDeviceId(
          {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "secret-token",
            deviceId: "STALE",
          },
          {},
          "default",
        ),
      ).resolves.toBe("skipped");
      await touchMatrixCredentials({}, "default");

      expect(loadMatrixCredentials({}, "default")).toBeNull();
      expect(openMatrixCredentialsStore({}).lookup("account:default")).toMatchObject({
        kind: "revoked",
      });
    },
  );

  it("does not read or remove legacy credential files at runtime", () => {
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    );

    expect(loadMatrixCredentials({}, "default")).toBeNull();
    clearMatrixCredentials({}, "default");
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("clears only the requested canonical account", async () => {
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "token",
    };
    await saveMatrixCredentials(credentials, {}, "default");
    await saveMatrixCredentials(credentials, {}, "ops");

    clearMatrixCredentials({}, "ops");

    expect(loadMatrixCredentials({}, "ops")).toBeNull();
    expect(openMatrixCredentialsStore({}).lookup("account:ops")).toMatchObject({
      kind: "revoked",
      accountId: "ops",
    });
    expect(loadMatrixCredentials({}, "default")).not.toBeNull();
  });

  it("reports persisted auth from SQLite for package-state probes", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);

    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
      },
      env,
      "default",
    );

    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(true);
  });

  it("keeps persisted-auth presence scoped to valid live records and the supplied environment", () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const store = createPluginStateSyncKeyedStore<unknown>("matrix", {
      namespace: "credentials",
      maxEntries: 256,
      overflowPolicy: "reject-new",
      env,
    });
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);
    store.register("account:default", {
      accountId: "default",
      homeserver: "https://matrix.example.org",
    });
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);
    store.register("account:default", {
      kind: "revoked",
      accountId: "default",
      revokedAt: "2026-01-01",
    });
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    store.register(
      "account:default",
      {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@fixture:example.org",
        accessToken: "synthetic-fixture-token",
        createdAt: "2026-01-01",
      },
      { ttlMs: 1 },
    );
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(true);
    expect(
      hasAnyMatrixAuth({ cfg: {}, env: { OPENCLAW_STATE_DIR: path.join(stateDir, "other") } }),
    ).toBe(false);
    clock.mockReturnValue(now + 2);
    expect(hasAnyMatrixAuth({ cfg: {}, env })).toBe(false);
  });

  it("requires a token match when userId is absent", () => {
    const stored = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      credentialsMatchConfig(stored, {
        homeserver: stored.homeserver,
        userId: "",
        accessToken: "tok-new",
      }),
    ).toBe(false);
    expect(
      credentialsMatchConfig(stored, {
        homeserver: stored.homeserver,
        userId: "",
        accessToken: "tok-123",
      }),
    ).toBe(true);
  });
});
