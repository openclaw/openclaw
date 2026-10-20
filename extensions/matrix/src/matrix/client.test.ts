import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { backfillMatrixAuthDeviceIdAfterStartup, resolveMatrixAuth } from "./client/config.js";
import * as credentialsReadModule from "./credentials-read.js";

const saveMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const saveBackfilledMatrixDeviceIdMock = vi.hoisted(() => vi.fn(async () => "saved"));
const repairCurrentTokenStorageMetaDeviceIdMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentialsAsync: vi.fn(async () => null),
  credentialsMatchConfig: vi.fn(() => false),
}));

vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  saveBackfilledMatrixDeviceId: saveBackfilledMatrixDeviceIdMock,
  saveMatrixCredentials: saveMatrixCredentialsMock,
}));

vi.mock("./client/storage.js", async () => {
  const actual = await vi.importActual<typeof import("./client/storage.js")>("./client/storage.js");
  return {
    ...actual,
    repairCurrentTokenStorageMetaDeviceId: repairCurrentTokenStorageMetaDeviceIdMock,
  };
});

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock,
}));

const authClientMocks = vi.hoisted(() => {
  const matrixDoRequest = vi.fn();
  class MatrixAuthedHttpClient {
    async requestJson(...args: unknown[]) {
      return await matrixDoRequest(...args);
    }
  }
  return { matrixDoRequest, MatrixAuthedHttpClient };
});
const matrixDoRequestMock = authClientMocks.matrixDoRequest;

vi.mock("./sdk/http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sdk/http-client.js")>()),
  MatrixAuthedHttpClient: authClientMocks.MatrixAuthedHttpClient,
}));

function expectAuthFields(auth: unknown, fields: Record<string, unknown>) {
  expect(auth).toEqual(expect.objectContaining(fields));
}

function expectSavedCredentials(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  accountId: string,
) {
  expect(mock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining(fields),
    expect.any(Object),
    accountId,
  );
}

function expectMatrixLoginCall(fields: Record<string, unknown>) {
  expect(matrixDoRequestMock).toHaveBeenNthCalledWith(1, {
    method: "POST",
    endpoint: "/_matrix/client/v3/login",
    timeoutMs: 60_000,
    body: expect.objectContaining(fields),
  });
}

function expectWhoami() {
  expect(matrixDoRequestMock).toHaveBeenCalledWith({
    method: "GET",
    endpoint: "/_matrix/client/v3/account/whoami",
    timeoutMs: 60_000,
  });
}

function expectNoBackfill() {
  expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
  expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
}

describe("client constructor lazy loading", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./client/create-client.js");
    vi.resetModules();
  });

  it("defers constructor module evaluation and forwards each creation independently", async () => {
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
  });
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

function createConfig(matrix: MatrixConfig, secrets?: CoreConfig["secrets"]): CoreConfig {
  return { channels: { matrix }, ...(secrets ? { secrets } : {}) };
}

function resolveAuth(matrix: MatrixConfig, accountId?: string, env: NodeJS.ProcessEnv = {}) {
  return resolveMatrixAuth({ cfg: createConfig(matrix), env, accountId });
}

describe("resolveMatrixAuth", () => {
  beforeEach(() => {
    loadCredentials.mockReset().mockResolvedValue(null);
    credentialsMatch.mockReset().mockReturnValue(false);
    saveMatrixCredentialsMock.mockReset();
    saveBackfilledMatrixDeviceIdMock.mockReset().mockResolvedValue("saved");
    repairCurrentTokenStorageMetaDeviceIdMock.mockReset().mockReturnValue(true);
    resolveConfiguredSecretInputStringMock.mockReset().mockResolvedValue({});
    matrixDoRequestMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
    expectAuthFields(auth, { ...expected, accountId: "ops" });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
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
      expectAuthFields(auth, { ...authFixture, deviceId: "DEVICE123", encryption: true });
      if (configuredToken) {
        expectSavedCredentials(saveMatrixCredentialsMock, savedCredentials, "default");
      }
    },
  );
  it("does not call whoami when token auth already has a userId and only deviceId is missing", async () => {
    matrixDoRequestMock.mockRejectedValue(new Error("whoami should not be called"));

    const auth = await resolveAuth({
      ...tokenConfig,
      encryption: true,
    });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expectAuthFields(auth, {
      ...authFixture,
      deviceId: undefined,
      encryption: true,
    });
  });

  it("retries password login when startup auth hits a transient network error", async () => {
    matrixDoRequestMock
      .mockRejectedValueOnce(networkError("socket hang up"))
      .mockResolvedValue({ ...identity, access_token: tokenConfig.accessToken });

    const auth = await resolveAuth(
      {
        accessToken: "legacy-token",
        accounts: { ops: { ...passwordConfig, encryption: true } },
      },
      "ops",
    );

    expect(matrixDoRequestMock).toHaveBeenCalledTimes(2);
    expectMatrixLoginCall({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "@bot:example.org" },
      password: "secret",
    });
    expectAuthFields(auth, {
      ...authFixture,
      accountId: "ops",
      deviceId: "DEVICE123",
      encryption: true,
    });
    expectSavedCredentials(saveMatrixCredentialsMock, savedCredentials, "ops");
  });

  it("best-effort backfills a missing deviceId after startup", async () => {
    matrixDoRequestMock.mockResolvedValue(identity);

    const deviceId = await backfill();

    expectWhoami();
    expectSavedCredentials(saveBackfilledMatrixDeviceIdMock, savedCredentials, "default");
    expect(repairCurrentTokenStorageMetaDeviceIdMock).toHaveBeenNthCalledWith(1, {
      ...authFixture,
      deviceId: "DEVICE123",
      env: {},
    });
    expect(
      expectDefined(
        repairCurrentTokenStorageMetaDeviceIdMock.mock.invocationCallOrder[0],
        "Matrix token repair invocation",
      ),
    ).toBeLessThan(
      expectDefined(
        saveBackfilledMatrixDeviceIdMock.mock.invocationCallOrder[0],
        "Matrix device save invocation",
      ),
    );
    expect(deviceId).toBe("DEVICE123");
  });

  it("skips deviceId backfill when auth already includes it", async () => {
    const deviceId = await backfill({ auth: { ...authFixture, deviceId: "DEVICE123" } });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
    expectNoBackfill();
    expect(deviceId).toBe("DEVICE123");
  });

  it.each([null, { user_id: 7 }, { device_id: false }])(
    "rejects malformed whoami identity fields before backfill persistence (%j)",
    async (invalidIdentity) => {
      matrixDoRequestMock.mockResolvedValue(invalidIdentity);
      await expect(backfill()).rejects.toThrow("Matrix whoami returned an invalid identity");
      expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
    },
  );

  it.each(["aborted", "replaced"])(
    "does not publish credentials when backfill is %s during metadata persistence",
    async (reason) => {
      matrixDoRequestMock.mockResolvedValue(identity);
      const metadata = createDeferred<boolean>();
      repairCurrentTokenStorageMetaDeviceIdMock.mockReturnValue(metadata.promise);
      const abortController = new AbortController();
      const pending = backfill({ abortSignal: abortController.signal });
      try {
        await vi.waitFor(() =>
          expect(repairCurrentTokenStorageMetaDeviceIdMock).toHaveBeenCalled(),
        );
        expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
        if (reason === "aborted") {
          abortController.abort();
        } else {
          loadCredentials.mockResolvedValue({
            ...cachedCredentials,
            accessToken: "newer-token",
            createdAt: "2026-09-01T00:00:00.000Z",
          });
        }
        metadata.resolve(true);
        await expect(pending).resolves.toBeUndefined();
        expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
      } finally {
        metadata.resolve(true);
        await pending;
      }
    },
  );

  it("fails before saving repaired credentials when storage metadata repair fails", async () => {
    matrixDoRequestMock.mockResolvedValue(identity);
    repairCurrentTokenStorageMetaDeviceIdMock.mockReturnValue(false);

    await expect(backfill()).rejects.toThrow(
      "Matrix deviceId backfill failed to repair current-token storage metadata",
    );
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("skips stale deviceId backfill writes after newer credentials take over", async () => {
    matrixDoRequestMock.mockResolvedValue(identity);
    loadCredentials.mockResolvedValue({
      ...cachedCredentials,
      accessToken: "tok-new",
      deviceId: "DEVICE999",
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const deviceId = await backfill({ auth: { ...authFixture, accessToken: "tok-old" } });

    expect(deviceId).toBeUndefined();
    expectNoBackfill();
  });

  it("skips persistence when startup backfill is aborted before whoami resolves", async () => {
    const whoami = createDeferred<typeof identity>();
    matrixDoRequestMock.mockReturnValue(whoami.promise);
    const abortController = new AbortController();
    const backfillPromise = backfill({ abortSignal: abortController.signal });

    await vi.waitFor(() => {
      expect(matrixDoRequestMock).toHaveBeenCalled();
    });
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
    matrixDoRequestMock.mockRejectedValueOnce(networkError("read ECONNRESET"));
    const abortController = new AbortController();
    const backfillPromise = backfill({ abortSignal: abortController.signal });

    try {
      await retryStarted.promise;
      expect(vi.getTimerCount()).toBe(1);
      abortController.abort();

      // Cancellation must settle the backoff without advancing its clock.
      await expect(backfillPromise).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(matrixDoRequestMock).toHaveBeenCalledTimes(1);
      expectNoBackfill();
    } finally {
      abortController.abort();
      vi.useRealTimers();
    }
  });

  it("resolves configured accessToken SecretRefs during Matrix auth", async () => {
    matrixDoRequestMock.mockResolvedValue(identity);
    resolveConfiguredSecretInputStringMock.mockResolvedValue({ value: "resolved-token" });

    const cfg = createConfig(
      {
        homeserver: tokenConfig.homeserver,
        accessToken: { source: "file", provider: "matrix-file", id: "value" },
      },
      {
        providers: {
          "matrix-file": {
            source: "file",
            path: "/tmp/matrix-token.txt",
            mode: "singleValue",
          },
        },
      },
    );

    const auth = await resolveMatrixAuth({ cfg, env: {} });

    expect(resolveConfiguredSecretInputStringMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: cfg,
        value: { source: "file", provider: "matrix-file", id: "value" },
        path: "channels.matrix.accessToken",
      }),
    );
    expectWhoami();
    expectAuthFields(auth, {
      ...authFixture,
      accessToken: "resolved-token",
      deviceId: "DEVICE123",
    });
  });

  it("does not resolve inactive password SecretRefs when scoped token auth wins", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: opsCredentials.userId,
      device_id: opsCredentials.deviceId,
    });

    const cfg = createConfig(
      {
        accounts: {
          ops: {
            homeserver: tokenConfig.homeserver,
            password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
          },
        },
      },
      { defaults: { env: "default" } },
    );

    installMatrixTestRuntime({ cfg });

    const auth = await resolveMatrixAuth({
      cfg,
      env: { MATRIX_OPS_ACCESS_TOKEN: opsCredentials.accessToken },
      accountId: "ops",
    });

    expectWhoami();
    expectAuthFields(auth, {
      ...opsCredentials,
      accountId: "ops",
      password: undefined,
    });
  });

  it("falls back to the sole configured account when no global homeserver is set", async () => {
    const soleAccount = {
      ...opsCredentials,
      homeserver: "https://ops.example.org",
      encryption: true,
    };
    const auth = await resolveAuth({
      accounts: { ops: soleAccount },
    });

    expectAuthFields(auth, {
      ...soleAccount,
      accountId: "ops",
    });
    expectSavedCredentials(
      saveMatrixCredentialsMock,
      { ...opsCredentials, homeserver: soleAccount.homeserver },
      "ops",
    );
  });
});
