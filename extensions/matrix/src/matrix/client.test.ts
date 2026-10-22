import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { backfillMatrixAuthDeviceIdAfterStartup, resolveMatrixAuth } from "./client/config.js";
import * as credentialsReadModule from "./credentials-read.js";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  backfill: vi.fn(async () => "saved"),
  repair: vi.fn(),
  secret: vi.fn(),
  request: vi.fn(),
}));

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentialsAsync: vi.fn(async () => null),
  credentialsMatchConfig: vi.fn(() => false),
}));

vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  saveBackfilledMatrixDeviceId: mocks.backfill,
  saveMatrixCredentials: mocks.save,
}));

vi.mock("./client/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client/storage.js")>()),
  repairCurrentTokenStorageMetaDeviceId: mocks.repair,
}));

// mock-isolation: Supply secret-resolution results without consulting configured providers or credentials.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: mocks.secret,
}));

vi.mock("./sdk/http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sdk/http-client.js")>()),
  MatrixAuthedHttpClient: class {
    async requestJson(...args: unknown[]) {
      return await mocks.request(...args);
    }
  },
}));

function expectSavedCredentials(
  mock: ReturnType<typeof vi.fn>,
  accountId = "default",
  fields = savedCredentials,
) {
  expect(mock.mock.calls[0]).toEqual([
    expect.objectContaining(fields),
    expect.any(Object),
    accountId,
  ]);
}

function expectWhoami() {
  expect(mocks.request).toHaveBeenCalledWith({
    method: "GET",
    endpoint: "/_matrix/client/v3/account/whoami",
    timeoutMs: 60_000,
  });
}

function expectNoBackfill() {
  expect(mocks.repair).not.toHaveBeenCalled();
  expect(mocks.backfill).not.toHaveBeenCalled();
}

it("defers constructor module evaluation and forwards each creation independently", async () => {
  vi.resetModules();
  try {
    const firstClient = { id: "first client" };
    const secondClient = { id: "second client" };
    const failure = new Error("creation failed");
    const createClient = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient)
      .mockRejectedValueOnce(failure);
    const evaluateConstructor = vi.fn(() => ({ createMatrixClient: createClient }));
    vi.doMock("./client/create-client.js", evaluateConstructor);

    const { createMatrixClient } = await import("./client.js");
    expect(evaluateConstructor).not.toHaveBeenCalled();

    const options = {
      homeserver: "https://matrix.example.org",
      accessToken: "synthetic-token",
      accountId: "ops",
      persistStorage: false,
      encryption: true,
      localTimeoutMs: 1234,
    };
    await expect(createMatrixClient(options)).resolves.toBe(firstClient);
    const secondOptions = { ...options, accountId: "other" };
    await expect(createMatrixClient(secondOptions)).resolves.toBe(secondClient);
    await expect(createMatrixClient(options)).rejects.toBe(failure);

    expect(createClient.mock.calls).toEqual([[options], [secondOptions], [options]]);
    expect(evaluateConstructor).toHaveBeenCalledTimes(1);
  } finally {
    vi.doUnmock("./client/create-client.js");
    vi.resetModules();
  }
});

const tokenConfig = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "tok-123",
};
const authFixture = { accountId: "default", ...tokenConfig };
const passwordConfig = {
  homeserver: tokenConfig.homeserver,
  userId: tokenConfig.userId,
  password: "secret", // pragma: allowlist secret
};
const identity = { user_id: "@bot:example.org", device_id: "DEVICE123" };
const cachedCredentials = { ...tokenConfig, createdAt: "2026-01-01T00:00:00.000Z" };
const savedCredentials = { ...tokenConfig, deviceId: "DEVICE123" };
const encryptedAuth = { ...authFixture, deviceId: "DEVICE123", encryption: true };
const opsCredentials = {
  homeserver: tokenConfig.homeserver,
  userId: "@ops:example.org",
  accessToken: "ops-token",
  deviceId: "OPSDEVICE",
};
const loadCredentials = vi.mocked(credentialsReadModule.loadMatrixCredentialsAsync);
const credentialsMatch = vi.mocked(credentialsReadModule.credentialsMatchConfig);

function networkError(message: string) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(message), { code: "ECONNRESET" }),
  });
}

function backfill(
  params: Partial<Parameters<typeof backfillMatrixAuthDeviceIdAfterStartup>[0]> = {},
) {
  return backfillMatrixAuthDeviceIdAfterStartup({ auth: authFixture, env: {}, ...params });
}

function createConfig(matrix: MatrixConfig): CoreConfig {
  return { channels: { matrix } };
}

function resolveAuth(matrix: MatrixConfig, accountId?: string, env: NodeJS.ProcessEnv = {}) {
  return resolveMatrixAuth({ cfg: createConfig(matrix), env, accountId });
}

describe("resolveMatrixAuth", () => {
  beforeEach(() => {
    loadCredentials.mockReset().mockResolvedValue(null);
    credentialsMatch.mockReset().mockReturnValue(false);
    mocks.save.mockReset();
    mocks.backfill.mockReset().mockResolvedValue("saved");
    mocks.repair.mockReset().mockReturnValue(true);
    mocks.secret.mockReset().mockResolvedValue({});
    mocks.request.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses cached matching credentials for env-backed named accounts without fresh auth", async () => {
    const cached = {
      ...cachedCredentials,
      userId: opsCredentials.userId,
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    };
    loadCredentials.mockResolvedValue(cached);
    credentialsMatch.mockReturnValue(true);
    const auth = await resolveAuth({ homeserver: tokenConfig.homeserver }, "ops", {
      MATRIX_OPS_USER_ID: opsCredentials.userId,
    });
    const { createdAt: _createdAt, ...expected } = cached;
    expect(auth).toMatchObject({ ...expected, accountId: "ops" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects embedded credentials in Matrix homeserver URLs", async () => {
    await expect(
      resolveAuth({ ...tokenConfig, homeserver: "https://user:pass@matrix.example.org" }),
    ).rejects.toThrow("Matrix homeserver URL must not include embedded credentials");
  });

  it.each([true, false])(
    "uses config deviceId when cached credentials lack it (configured token: %s)",
    async (configuredToken) => {
      loadCredentials.mockResolvedValue(cachedCredentials);
      credentialsMatch.mockReturnValue(true);
      const auth = await resolveAuth({
        ...savedCredentials,
        accessToken: configuredToken ? "tok-123" : undefined,
        encryption: true,
      });
      expect(auth).toMatchObject(encryptedAuth);
      if (configuredToken) {
        expectSavedCredentials(mocks.save);
      }
    },
  );
  it("does not call whoami when token auth already has a userId and only deviceId is missing", async () => {
    mocks.request.mockRejectedValue(new Error("whoami should not be called"));

    const auth = await resolveAuth({ ...tokenConfig, encryption: true });

    expect(mocks.request).not.toHaveBeenCalled();
    expect(auth).toMatchObject({ ...authFixture, deviceId: undefined, encryption: true });
  });

  it("retries password login when startup auth hits a transient network error", async () => {
    mocks.request
      .mockRejectedValueOnce(networkError("socket hang up"))
      .mockResolvedValue({ ...identity, access_token: tokenConfig.accessToken });

    const auth = await resolveAuth(
      {
        accessToken: "legacy-token",
        accounts: { ops: { ...passwordConfig, encryption: true } },
      },
      "ops",
    );

    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      endpoint: "/_matrix/client/v3/login",
      timeoutMs: 60_000,
      body: expect.objectContaining({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "secret",
      }),
    });
    expect(auth).toMatchObject({ ...encryptedAuth, accountId: "ops" });
    expectSavedCredentials(mocks.save, "ops");
  });

  it("best-effort backfills a missing deviceId after startup", async () => {
    mocks.request.mockResolvedValue(identity);

    const deviceId = await backfill();

    expectWhoami();
    expectSavedCredentials(mocks.backfill);
    expect(mocks.repair).toHaveBeenNthCalledWith(1, {
      ...authFixture,
      deviceId: "DEVICE123",
      env: {},
    });
    expect(
      expectDefined(mocks.repair.mock.invocationCallOrder[0], "Matrix token repair invocation"),
    ).toBeLessThan(
      expectDefined(mocks.backfill.mock.invocationCallOrder[0], "Matrix device save invocation"),
    );
    expect(deviceId).toBe("DEVICE123");
  });

  it("skips deviceId backfill when auth already includes it", async () => {
    const deviceId = await backfill({ auth: { ...authFixture, deviceId: "DEVICE123" } });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expectNoBackfill();
    expect(deviceId).toBe("DEVICE123");
  });

  it.each([null, { user_id: 7 }, { device_id: false }])(
    "rejects malformed whoami identity fields before backfill persistence (%j)",
    async (invalidIdentity) => {
      mocks.request.mockResolvedValue(invalidIdentity);
      await expect(backfill()).rejects.toThrow("Matrix whoami returned an invalid identity");
      expect(mocks.backfill).not.toHaveBeenCalled();
    },
  );

  it.each(["aborted", "replaced"])(
    "does not publish credentials when backfill is %s during metadata persistence",
    async (reason) => {
      mocks.request.mockResolvedValue(identity);
      const metadata = createDeferred<boolean>();
      mocks.repair.mockReturnValue(metadata.promise);
      const abortController = new AbortController();
      const pending = backfill({ abortSignal: abortController.signal });
      try {
        await vi.waitFor(() => expect(mocks.repair).toHaveBeenCalled());
        expect(mocks.backfill).not.toHaveBeenCalled();
        if (reason === "aborted") {
          abortController.abort();
        } else {
          loadCredentials.mockResolvedValue({
            ...cachedCredentials,
            accessToken: "newer-token",
          });
        }
        metadata.resolve(true);
        await expect(pending).resolves.toBeUndefined();
        expect(mocks.backfill).not.toHaveBeenCalled();
      } finally {
        metadata.resolve(true);
        await pending;
      }
    },
  );

  it("fails before saving repaired credentials when storage metadata repair fails", async () => {
    mocks.request.mockResolvedValue(identity);
    mocks.repair.mockReturnValue(false);

    await expect(backfill()).rejects.toThrow(
      "Matrix deviceId backfill failed to repair current-token storage metadata",
    );
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it("skips stale deviceId backfill writes after newer credentials take over", async () => {
    mocks.request.mockResolvedValue(identity);
    loadCredentials.mockResolvedValue({
      ...cachedCredentials,
      accessToken: "tok-new",
    });

    const deviceId = await backfill({ auth: { ...authFixture, accessToken: "tok-old" } });

    expect(deviceId).toBeUndefined();
    expectNoBackfill();
  });

  it("skips persistence when startup backfill is aborted before whoami resolves", async () => {
    const whoami = createDeferred<typeof identity>();
    mocks.request.mockReturnValue(whoami.promise);
    const abortController = new AbortController();
    const backfillPromise = backfill({ abortSignal: abortController.signal });

    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
    abortController.abort();
    whoami.resolve(identity);

    await expect(backfillPromise).resolves.toBeUndefined();
    expectNoBackfill();
  });

  it("stops waiting on whoami retry backoff when startup backfill is aborted", async () => {
    vi.useFakeTimers();
    const retryStarted = createDeferred<void>();
    const sleepWithAbort = runtimeEnv.sleepWithAbort;
    vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((...args) => {
      const sleeping = sleepWithAbort(...args);
      retryStarted.resolve();
      return sleeping;
    });
    mocks.request.mockRejectedValueOnce(networkError("read ECONNRESET"));
    const abortController = new AbortController();
    const backfillPromise = backfill({ abortSignal: abortController.signal });

    try {
      await retryStarted.promise;
      expect(vi.getTimerCount()).toBe(1);
      abortController.abort();

      // Cancellation must settle the backoff without advancing its clock.
      await expect(backfillPromise).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expectNoBackfill();
    } finally {
      abortController.abort();
      vi.useRealTimers();
    }
  });

  it("resolves configured accessToken SecretRefs during Matrix auth", async () => {
    mocks.request.mockResolvedValue(identity);
    mocks.secret.mockResolvedValue({ value: "resolved-token" });

    const secretRef = { source: "file", provider: "matrix-file", id: "value" } as const;
    const cfg = createConfig({ homeserver: tokenConfig.homeserver, accessToken: secretRef });

    const auth = await resolveMatrixAuth({ cfg, env: {} });

    expect(mocks.secret).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: cfg,
        value: secretRef,
        path: "channels.matrix.accessToken",
      }),
    );
    expectWhoami();
    expect(auth).toMatchObject({
      ...authFixture,
      accessToken: "resolved-token",
      deviceId: "DEVICE123",
    });
  });

  it("does not resolve inactive password SecretRefs when scoped token auth wins", async () => {
    mocks.request.mockResolvedValue({
      user_id: opsCredentials.userId,
      device_id: opsCredentials.deviceId,
    });

    const cfg = createConfig({
      accounts: {
        ops: {
          homeserver: tokenConfig.homeserver,
          password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
        },
      },
    });

    installMatrixTestRuntime({ cfg });

    const auth = await resolveMatrixAuth({
      cfg,
      env: { MATRIX_OPS_ACCESS_TOKEN: opsCredentials.accessToken },
      accountId: "ops",
    });

    expectWhoami();
    expect(auth).toMatchObject({ ...opsCredentials, accountId: "ops", password: undefined });
  });

  it("falls back to the sole configured account when no global homeserver is set", async () => {
    const soleAccount = {
      ...opsCredentials,
      homeserver: "https://ops.example.org",
      encryption: true,
    };
    const auth = await resolveAuth({ accounts: { ops: soleAccount } });

    expect(auth).toMatchObject({ ...soleAccount, accountId: "ops" });
    expectSavedCredentials(mocks.save, "ops", {
      ...opsCredentials,
      homeserver: soleAccount.homeserver,
    });
  });
});
