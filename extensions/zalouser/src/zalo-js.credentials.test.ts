import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRuntimeMock,
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API, LoginQRCallbackEvent } from "./zca-client.js";
import { LoginQRCallbackEventType } from "./zca-constants.js";

const createZaloMock = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    // Release the worker store before removing its files on Windows.
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
let stateDir: string;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const cookieJar = (value: string, key = "zpsid") => [{ key, value, domain: "chat.zalo.me" }];
const storedCredentials = (
  cookie: unknown[],
  overrides: Partial<Omit<StoredZaloCredentials, "profile" | "cookie">> = {},
) => ({
  imei: "device",
  userAgent: "agent",
  createdAt: "2026-04-01T00:00:00.000Z",
  cookie,
  ...overrides,
});

function credentialGate() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    entered,
    release,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

async function expectPending(entered: Promise<void>, result: Promise<unknown>) {
  await expect(
    Promise.race([entered.then(() => "pending"), result.then(() => "completed")]),
  ).resolves.toBe("pending");
}

// mock-isolation: Credential lifecycle tests must not authenticate a live Zalo client.
vi.mock("./zca-client.js", () => ({ createZalo: createZaloMock }));
vi.mock("./qr-temp-file.js", () => ({ writeQrDataUrlToTempFile: async () => undefined }));

import { zalouserSetupPlugin } from "./channel.setup.js";
import { getZalouserRuntime, setZalouserRuntime } from "./runtime.js";
import {
  isZaloCredentialRevocation,
  loadStoredZaloCredentials,
  refreshStoredZaloCredentials,
  resolveLegacyZalouserCredentialsPath,
  saveStoredZaloCredentials,
  type StoredZaloCredentials,
} from "./session-state.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriends,
  logoutZaloProfile,
  sendZaloLink,
  sendZaloReaction,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

async function readCredentials(profile: string): Promise<StoredZaloCredentials> {
  const stored = await loadStoredZaloCredentials(profile, { OPENCLAW_STATE_DIR: stateDir });
  if (!stored) {
    throw new Error("Expected stored Zalo credentials");
  }
  return stored;
}

async function seedCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
  root = stateDir,
): Promise<void> {
  await saveStoredZaloCredentials(profile, credentials, { OPENCLAW_STATE_DIR: root });
}

type MockApiOptions = Partial<ReturnType<API["getContext"]>> & {
  cookies: unknown[] | (() => unknown[]);
  getAllFriends?: API["getAllFriends"];
};

function createMockApi({
  cookies,
  getAllFriends = vi.fn(async () => []),
  ...context
}: MockApiOptions): API {
  return {
    getContext: () => ({ imei: "device", userAgent: "agent", ...context }),
    getCookie: () => ({
      toJSON: () => ({ cookies: typeof cookies === "function" ? cookies() : cookies }),
    }),
    fetchAccountInfo: async () => ({ userId: "user-1", displayName: "Zalo User" }),
    getAllFriends,
    listener: { stop: vi.fn() },
  } as unknown as API;
}

function mockQrLogin(api: API, cookie?: unknown[]) {
  createZaloMock.mockResolvedValueOnce({
    loginQR: async (_options: unknown, callback?: (event: LoginQRCallbackEvent) => unknown) => {
      callback?.({
        type: LoginQRCallbackEventType.QRCodeGenerated,
        data: { code: "qr-code", image: "data:image/png;base64,abc123" },
        actions: { saveToFile: vi.fn(async () => undefined), retry: vi.fn(), abort: vi.fn() },
      });
      if (cookie) {
        callback?.({
          type: LoginQRCallbackEventType.GotLoginInfo,
          data: { cookie, imei: "callback-imei", userAgent: "callback-user-agent" },
          actions: null,
        });
      }
      return api;
    },
  });
}

describe("zalouser credential persistence", () => {
  let before: Partial<Record<"apply" | "revoke" | "register", () => Promise<void>>>;
  let afterRegister: (() => void) | undefined;
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-zalouser-credentials-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const runtime = createPluginRuntimeMock();
    before = {};
    afterRegister = undefined;
    runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority: PluginStateActionAuthority = { assertCurrent: () => {} },
    ): PluginStateKeyedStore<T, 2> => {
      const store = createPluginStateKeyedStoreV2ForTests<T>("zalouser", options, authority);
      return {
        ...store,
        register: async (...args) => {
          await before.register?.();
          await store.register(...args);
          afterRegister?.();
        },
        compareAndApply: async (...args) => {
          const intent = args[2];
          if (intent.action === "set" && isZaloCredentialRevocation(intent.value)) {
            await before.revoke?.();
          } else {
            await before.apply?.();
          }
          return await store.compareAndApply(...args);
        },
      };
    };
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("zalouser", options);
    setZalouserRuntime(runtime);
    createZaloMock.mockReset();
  });

  it("keeps restoration on its original state directory while waiting for logout", async () => {
    const otherStateDir = tempDirs.make("openclaw-zalouser-other-credentials-");
    const profile = "logout-state-root";
    const stored = storedCredentials(cookieJar("stored"));
    await seedCredentials(profile, stored);
    await seedCredentials(profile, stored, otherStateDir);
    createZaloMock.mockResolvedValue({
      login: async () =>
        createMockApi({ imei: stored.imei, userAgent: stored.userAgent, cookies: stored.cookie }),
    });
    const { entered, release, wait } = credentialGate();
    before.revoke = wait;

    const syncOpen = vi.spyOn(getZalouserRuntime().state, "openSyncKeyedStore");
    const logout = logoutZaloProfile(profile);
    await expectPending(entered.promise, logout);
    expect(syncOpen).not.toHaveBeenCalled();
    const restored = getZaloUserInfo(profile).then(
      () => "restored",
      () => "missing",
    );
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: otherStateDir }, async () => {
        release.resolve();
        await logout;
        await expect(restored).resolves.toBe("missing");
      });
      expect(createZaloMock).not.toHaveBeenCalled();
      await expect(logout).resolves.toMatchObject({ cleared: true, loggedOut: true });
      expect(await loadStoredZaloCredentials(profile)).toBeNull();
    } finally {
      release.resolve();
      await Promise.all([logout, restored]);
      syncOpen.mockRestore();
    }
  });

  it("does not persist a registered setup login after its host closes during the credential write", async () => {
    const profile = "setup-closed";
    const { entered, release, wait } = credentialGate();
    let closed = false;
    const assertPersistentEffectCurrent = () => {
      if (closed) {
        throw new Error("setup host closed");
      }
    };
    before.register = wait;
    const api = createMockApi({ cookies: cookieJar("new") });
    mockQrLogin(api);

    const setup = runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(zalouserSetupPlugin),
      cfg: { channels: { zalouser: { profile } } },
      prompter: createTestWizardPrompter({
        confirm: vi.fn(async ({ message }) =>
          ["Login via QR code now?", "Did you scan and approve the QR on your phone?"].includes(
            message,
          ),
        ),
      }),
      options: {
        beforePersistentEffect: async () => assertPersistentEffectCurrent(),
        assertPersistentEffectCurrent,
      },
    });
    try {
      await expectPending(entered.promise, setup);
      closed = true;
    } finally {
      release.resolve();
      await setup;
    }
    expect(await loadStoredZaloCredentials(profile)).toBeNull();
  });

  it("persists the final API cookie jar and logs out without parent SQLite work", async () => {
    const registered = createDeferred<void>();
    afterRegister = () => registered.resolve();
    const profile = "qr-refresh";
    const callbackCookie = cookieJar("callback");
    const refreshedCookie = cookieJar("refreshed");
    const identity = { imei: "api-imei", userAgent: "api-user-agent", language: "vi" };
    const api = createMockApi({ ...identity, cookies: refreshedCookie });

    mockQrLogin(api, callbackCookie);

    const native = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const Database = native.DatabaseSync;
    const sql = [
      vi.spyOn(native, "DatabaseSync"),
      ...(["close", "prepare", "exec"] as const).map((method) =>
        vi.spyOn(Database.prototype, method),
      ),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    try {
      // Calibrate every observer and finish runtime capability checks before the cold flow.
      const calibration = openNodeSqliteDatabase(":memory:");
      calibration.exec("CREATE TABLE calibration (value INTEGER)");
      calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
      const query = calibration.prepare("SELECT value FROM calibration");
      query.get();
      query.all();
      Array.from(query.iterate());
      calibration.close();
      for (const call of sql) {
        expect(call).toHaveBeenCalled();
        call.mockClear();
      }
      await expect(access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await startZaloQrLogin({ profile, timeoutMs: 1000 });
      await registered.promise;

      const loginResult = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });
      expect(loginResult.connected, loginResult.message).toBe(true);

      expect(await readCredentials(profile)).toMatchObject({
        ...identity,
        cookie: refreshedCookie,
      });
      await expect(
        access(resolveLegacyZalouserCredentialsPath(profile, { OPENCLAW_STATE_DIR: stateDir })),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await access(path.join(stateDir, "state", "openclaw.sqlite"));
      await expect(logoutZaloProfile(profile)).resolves.toMatchObject({
        cleared: true,
        loggedOut: true,
      });
      expect(await loadStoredZaloCredentials(profile)).toBeNull();
      await closeOpenClawStateDatabaseAsync();
      for (const call of sql) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      sql.forEach((call) => call.mockRestore());
    }
  });

  it("revalidates setup ownership immediately before QR credentials are written", async () => {
    const profile = "qr-stale-owner";
    const guardError = new Error("verified inference changed");
    const beforeCredentialPersistence = vi.fn(async () => {
      throw guardError;
    });
    const api = createMockApi({
      imei: "api-imei",
      userAgent: "api-user-agent",
      cookies: cookieJar("stale-owner"),
    });

    mockQrLogin(api);

    const started = await startZaloQrLogin({
      profile,
      timeoutMs: 1000,
      beforeCredentialPersistence,
    });
    const waited = await waitForZaloQrLogin({ profile, timeoutMs: 1000 });

    expect(`${started.message} ${waited.message}`).toContain(guardError.message);
    expect(beforeCredentialPersistence).toHaveBeenCalledTimes(1);
    expect(await loadStoredZaloCredentials(profile)).toBeNull();
  });

  it("caps oversized QR start timeout before computing the polling deadline", async () => {
    let loginStarted = false;
    let postStartClockReads = 0;
    createZaloMock.mockImplementationOnce(async () => {
      loginStarted = true;
      return {
        loginQR: async () => new Promise(() => {}),
      };
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      if (!loginStarted) {
        return 0;
      }
      return postStartClockReads++ === 0 ? 0 : MAX_TIMER_TIMEOUT_MS + 1;
    });
    try {
      const result = await startZaloQrLogin({
        profile: "qr-timeout-cap",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(result.message).toBe(
        "Still preparing QR. Call wait to continue checking login status.",
      );
      expect(postStartClockReads).toBeGreaterThanOrEqual(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each(["persist", "read-only"] as const)(
    "handles API cookie changes in %s mode",
    async (mode) => {
      const profile = `cookies-${mode}`;
      const storedCookie = [...cookieJar("stored"), ...cookieJar("secondary", "zpw")];
      const loginCookie = cookieJar("login");
      const refreshedCookie = cookieJar("refreshed");
      const identity = { imei: "stored-imei", userAgent: "stored-user-agent" };
      await seedCredentials(profile, storedCredentials(storedCookie, identity));
      const storedBefore = await readCredentials(profile);
      let currentCookie = loginCookie;
      const api = createMockApi({
        ...identity,
        language: "vi",
        cookies: () => currentCookie,
        getAllFriends: async () => {
          currentCookie = refreshedCookie;
          return mode === "persist"
            ? [
                {
                  userId: "friend-1",
                  username: "friend-1",
                  displayName: "Friend One",
                  zaloName: "Friend One",
                  avatar: "",
                },
              ]
            : [];
        },
      });
      const login = vi.fn(async () => api);
      createZaloMock.mockResolvedValueOnce({ login });

      if (mode === "persist") {
        await expect(checkZaloAuthenticated(profile)).resolves.toBe(true);
        expect(login).toHaveBeenCalledWith({
          ...identity,
          cookie: storedCookie,
          language: undefined,
        });
        expect(await readCredentials(profile)).toMatchObject({
          cookie: loginCookie,
          createdAt: "2026-04-01T00:00:00.000Z",
          lastUsedAt: expect.stringMatching(ISO_TIMESTAMP_RE),
        });
      }
      await expect(
        listZaloFriends(profile, {
          credentialPersistence: mode === "read-only" ? "read-only" : "persist",
        }),
      ).resolves.toStrictEqual(
        mode === "persist"
          ? [{ userId: "friend-1", displayName: "Friend One", avatar: undefined }]
          : [],
      );
      const stored = await readCredentials(profile);
      if (mode === "read-only") {
        expect(stored).toEqual(storedBefore);
      } else {
        expect(stored).toMatchObject({
          cookie: refreshedCookie,
          createdAt: "2026-04-01T00:00:00.000Z",
          lastUsedAt: expect.stringMatching(ISO_TIMESTAMP_RE),
        });
      }
    },
  );

  it.each(["save", "logout", "failure"] as const)(
    "settles ordinary API refresh before returning after %s",
    async (outcome) => {
      const profile = `settlement-${outcome}`;
      const storedCookie = cookieJar("stored");
      const refreshedCookie = cookieJar("refreshed");
      await seedCredentials(profile, storedCredentials(storedCookie));
      let currentCookie = storedCookie;
      let nextCookie = refreshedCookie;
      const newestCookie = cookieJar("newest");
      const secondApiCall = createDeferred<void>();
      let apiCalls = 0;
      let applyCalls = 0;
      let secondResult: Promise<unknown> | undefined;
      const api = createMockApi({
        cookies: () => currentCookie,
        getAllFriends: async () => {
          currentCookie = nextCookie;
          if (++apiCalls === 2) {
            secondApiCall.resolve();
          }
          return [];
        },
      });
      createZaloMock.mockResolvedValueOnce({ login: async () => api });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      await expect(getZaloUserInfo(profile)).resolves.toMatchObject({ userId: "user-1" });
      const syncOpen = vi.spyOn(getZalouserRuntime().state, "openSyncKeyedStore");
      before.apply = async () => {
        applyCalls += 1;
        entered.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("synthetic persistence failure");
        }
      };
      const result = listZaloFriends(profile);
      try {
        await expectPending(entered.promise, result);
        expect(syncOpen).not.toHaveBeenCalled();
        if (outcome === "logout") {
          await logoutZaloProfile(profile);
        } else if (outcome === "save") {
          nextCookie = newestCookie;
          secondResult = listZaloFriends(profile);
          await secondApiCall.promise;
          expect(applyCalls).toBe(1);
        }
      } finally {
        release.resolve();
        await Promise.all([result, secondResult]);
      }
      await expect(result).resolves.toEqual([]);
      const stored = await loadStoredZaloCredentials(profile);
      expect(stored?.cookie ?? null).toEqual(
        outcome === "logout" ? null : outcome === "failure" ? storedCookie : newestCookie,
      );
      if (outcome === "logout") {
        // Revocation must also fence a late writer whose API-current check still succeeds.
        await expect(
          refreshStoredZaloCredentials(profile, storedCredentials(cookieJar("late")), () => true),
        ).resolves.toBeNull();
        expect(await loadStoredZaloCredentials(profile)).toBeNull();
      }
      if (outcome === "failure") {
        before.apply = undefined;
        await listZaloFriends(profile);
        expect((await loadStoredZaloCredentials(profile))?.cookie).toEqual(refreshedCookie);
      }
      syncOpen.mockRestore();
    },
  );

  it("retries a failed session restore and reuses the successful API", async () => {
    const profile = "restore-retry";
    const cookie = cookieJar("stored");
    await seedCredentials(profile, storedCredentials(cookie));
    const failure = new Error("Zalo login failed");
    const api = createMockApi({ cookies: cookie });
    const login = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(api);
    createZaloMock.mockResolvedValue({ login });

    await expect(getZaloUserInfo(profile)).rejects.toBe(failure);
    await expect(getZaloUserInfo(profile)).resolves.toMatchObject({ userId: "user-1" });
    await expect(listZaloFriends(profile)).resolves.toEqual([]);
    expect(login).toHaveBeenCalledTimes(2);
    expect((await readCredentials(profile)).cookie).toEqual(cookie);
  });

  it("does not let a superseded restore overwrite or invalidate a replacement session", async () => {
    const profile = "restore-logout";
    const cookie = cookieJar("stored");
    await seedCredentials(profile, storedCredentials(cookie));
    const originalFriends = vi.fn(async () => []);
    const replacementFriends = vi.fn(async () => []);
    const api = createMockApi({ cookies: cookie, getAllFriends: originalFriends });
    const replacementCookie = cookieJar("replacement");
    const replacementApi = createMockApi({
      imei: "replacement",
      cookies: replacementCookie,
      getAllFriends: replacementFriends,
    });
    createZaloMock.mockResolvedValueOnce({ login: async () => api });
    createZaloMock.mockResolvedValueOnce({ login: async () => replacementApi });
    const { entered, release, wait } = credentialGate();
    before.apply = wait;
    const restored = checkZaloAuthenticated(profile);
    try {
      await expectPending(entered.promise, restored);
      await logoutZaloProfile(profile);
      before.apply = undefined;
      await seedCredentials(
        profile,
        storedCredentials(replacementCookie, {
          imei: "replacement",
          createdAt: "2026-04-02T00:00:00.000Z",
        }),
      );
      await expect(getZaloUserInfo(profile.toUpperCase())).resolves.toMatchObject({
        userId: "user-1",
      });
    } finally {
      release.resolve();
      await restored;
    }
    await expect(restored).resolves.toBe(false);
    await expect(listZaloFriends(profile)).resolves.toEqual([]);
    expect((await loadStoredZaloCredentials(profile))?.cookie).toEqual(replacementCookie);
    expect(originalFriends).not.toHaveBeenCalled();
    expect(replacementFriends).toHaveBeenCalledOnce();
  });

  it.each(["reaction", "link"] as const)("rejects %s without a session", async (action) => {
    const send =
      action === "reaction"
        ? sendZaloReaction({
            profile: "missing-session",
            threadId: "thread-1",
            msgId: "msg-1",
            cliMsgId: "cli-1",
            emoji: "like",
          })
        : sendZaloLink("thread-1", "https://example.com", { profile: "missing-session" });
    await expect(send).rejects.toThrow("No saved Zalo session");
  });
});
