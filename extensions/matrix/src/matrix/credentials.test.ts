import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasAnyMatrixAuthAsync } from "../../auth-presence.js";
import { getMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { resolveConfiguredMatrixBotUserIds } from "./accounts.js";
import { openMatrixCredentialsStore } from "./credentials-read.js";
import {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

const auth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "secret-token",
};
const storedAuth = { ...auth, createdAt: "2026-01-01T00:00:00.000Z" };
const raw = (accountId = "default") =>
  openMatrixCredentialsStore({}).lookup(`account:${accountId}`);
const load = () => loadMatrixCredentials({}, "default");
const save = (value: Parameters<typeof saveMatrixCredentials>[0] = auth) =>
  saveMatrixCredentials(value, {}, "default");
const backfill = (value: Parameters<typeof saveBackfilledMatrixDeviceId>[0]) =>
  saveBackfilledMatrixDeviceId(value, {}, "default");
const clear = () => clearMatrixCredentials({}, "default");
const touch = () => touchMatrixCredentials({}, "default");

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
        { ...auth, userId, accessToken: "synthetic-token" },
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
    const openStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
    const observedSources: Array<[string | undefined, string | undefined]> = [];
    vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation(
      <T>(options: Parameters<typeof runtime.state.openKeyedStoreV2>[0]) => {
        const { OPENCLAW_STATE_DIR, OPENCLAW_SUPERVISOR_MODE } = options.env ?? {};
        observedSources.push([OPENCLAW_STATE_DIR, OPENCLAW_SUPERVISOR_MODE]);
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
      [stateDir, mixedCase && platform === "linux" ? undefined : "internal"],
      [stateDir, mixedCase && platform === "linux" ? undefined : "internal"],
    ]);
    expect(fs.existsSync(path.join(stateDir, "replacement"))).toBe(false);
  },
);

it("touch updates lastUsedAt while preserving createdAt", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
  await save();
  const initial = load();
  expect(initial).toMatchObject({ createdAt: expect.any(String) });

  vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
  await touch();
  expect(load()).toMatchObject({
    createdAt: initial?.createdAt,
    lastUsedAt: "2026-03-01T10:05:00.000Z",
  });
});

it("omits an explicitly undefined device id from persisted credentials", async () => {
  const withoutDevice = { ...auth, deviceId: undefined };
  await save(withoutDevice);
  await expect(saveBackfilledMatrixDeviceId(withoutDevice, {}, "ops")).resolves.toBe("saved");

  expect(raw()).not.toHaveProperty("deviceId");
  expect(raw("ops")).not.toHaveProperty("deviceId");
});

it("backfills a matching device id but preserves newer auth lineage", async () => {
  const current = { ...auth, accessToken: "tok-new" };
  const stale = { ...auth, accessToken: "tok-old", deviceId: "STALE" };
  await save(current);

  await expect(backfill({ ...current, deviceId: "DEVICE123" })).resolves.toBe("saved");
  await expect(backfill(stale)).resolves.toBe("skipped");

  expect(load()).toMatchObject({ accessToken: "tok-new", deviceId: "DEVICE123" });
});

it.each(["before", "during comparison"])(
  "does not let delayed background writes undo credential revocation %s",
  async (timing) => {
    await save();
    if (timing === "before") {
      await clear();
    } else {
      const runtime = getMatrixRuntime();
      const openStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
      let revoked = false;
      vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation(
        <T>(options: OpenAsyncKeyedStoreOptions) => {
          const store = openStore<T>(options);
          if (store.compareAndApply) {
            const compare = store.compareAndApply.bind(store);
            store.compareAndApply = async (...args) => {
              if (!revoked) {
                revoked = true;
                await clear();
              }
              return await compare(...args);
            };
          }
          return store;
        },
      );
    }

    await expect(backfill({ ...auth, deviceId: "STALE" })).resolves.toBe("skipped");
    await touch();

    expect(load()).toBeNull();
    expect(raw()).toMatchObject({ kind: "revoked" });
  },
);

it("does not read or remove legacy credential files at runtime", async () => {
  const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(storedAuth));

  expect(load()).toBeNull();
  await clear();
  expect(fs.existsSync(legacyPath)).toBe(true);
});

it("clears only the requested canonical account", async () => {
  await save();
  await saveMatrixCredentials(auth, {}, "ops");

  await clearMatrixCredentials({}, "ops");

  expect(loadMatrixCredentials({}, "ops")).toBeNull();
  expect(raw("ops")).toMatchObject({ kind: "revoked", accountId: "ops" });
  expect(load()).not.toBeNull();
});

it("keeps persisted-auth presence scoped to valid live records and the supplied environment", async () => {
  const accountId = "default";
  const key = `account:${accountId}`;
  const hasAuth = (root = stateDir) =>
    hasAnyMatrixAuthAsync({ cfg: {}, env: { OPENCLAW_STATE_DIR: root } });
  const store = createPluginStateSyncKeyedStore<unknown>("matrix", {
    namespace: "credentials",
    maxEntries: 256,
    overflowPolicy: "reject-new",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  expect(await hasAuth()).toBe(false);
  store.register(key, { accountId, homeserver: auth.homeserver });
  expect(await hasAuth()).toBe(false);
  store.register(key, { kind: "revoked", accountId, revokedAt: "2026-01-01" });
  expect(await hasAuth()).toBe(false);
  const credentials = { ...storedAuth, accountId };
  store.register(key, credentials, { ttlMs: 60_000 });
  expect(await hasAuth()).toBe(true);
  expect(await hasAuth(path.join(stateDir, "other"))).toBe(false);
  // Commit an expired record through the owner so its receipt invalidates the warm list.
  const now = vi.spyOn(Date, "now").mockReturnValue(1);
  store.register(key, credentials, { ttlMs: 60_000 });
  now.mockRestore();
  expect(await hasAuth()).toBe(false);
});

it.each([
  ["tok-new", false],
  ["tok-123", true],
] as const)("requires token match for %s without userId", (accessToken, expected) => {
  const stored = { ...storedAuth, accessToken: "tok-123" };
  expect(
    credentialsMatchConfig(stored, { homeserver: stored.homeserver, userId: "", accessToken }),
  ).toBe(expected);
});
