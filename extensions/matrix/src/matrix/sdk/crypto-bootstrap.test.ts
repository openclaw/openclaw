import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MatrixCryptoBootstrapper, type MatrixCryptoBootstrapperDeps } from "./crypto-bootstrap.js";
import {
  MatrixCrossSigningResetRequiredError,
  MatrixUiaUnsupportedStagesError,
  type MatrixCryptoBootstrapApi,
  type MatrixRawEvent,
  type MatrixUiaResponseBody,
} from "./types.js";

function uiaError(body: MatrixUiaResponseBody): Error & {
  httpStatus: number;
  data: MatrixUiaResponseBody;
} {
  const err = new Error("Auth required") as Error & {
    httpStatus: number;
    data: MatrixUiaResponseBody;
  };
  err.httpStatus = 401;
  err.data = body;
  return err;
}

type BootstrapCrossSigningMock = Mock<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>;

function createBootstrapperDeps() {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getPassword: vi.fn<() => string | undefined>(() => "super-secret-password"),
    getDeviceId: vi.fn(() => "DEVICE123"),
    verificationManager: {
      trackVerificationRequest: vi.fn(),
    },
    recoveryKeyStore: {
      bootstrapSecretStorageWithRecoveryKey: vi.fn(async () => {}),
    },
    decryptBridge: {
      bindCryptoRetrySignals: vi.fn(),
    },
    // Default to no MAS — individual MAS-specific tests override.
    getHomeserverCapabilities: undefined as
      | undefined
      | (() => Promise<{ msAuthService?: boolean }>),
  };
}

function createCryptoApi(overrides?: Partial<MatrixCryptoBootstrapApi>): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    requestOwnUserVerification: vi.fn(async () => null),
    ...overrides,
  };
}

function createVerifiedDeviceStatus(overrides?: {
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
}) {
  return {
    isVerified: () => true,
    localVerified: overrides?.localVerified ?? true,
    crossSigningVerified: overrides?.crossSigningVerified ?? true,
    signedByOwner: overrides?.signedByOwner ?? true,
  };
}

function createBootstrapperHarness(
  cryptoOverrides?: Partial<MatrixCryptoBootstrapApi>,
  depsOverrides?: Partial<ReturnType<typeof createBootstrapperDeps>>,
) {
  const deps = {
    ...createBootstrapperDeps(),
    ...depsOverrides,
  };
  const crypto = createCryptoApi(cryptoOverrides);
  const bootstrapper = new MatrixCryptoBootstrapper(
    deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
  );
  return { deps, crypto, bootstrapper };
}

async function runExplicitSecretStorageRepairScenario(firstError: string) {
  const bootstrapCrossSigning = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error(firstError))
    .mockResolvedValueOnce(undefined);
  const { deps, crypto, bootstrapper } = createBootstrapperHarness({
    bootstrapCrossSigning,
    isCrossSigningReady: vi.fn(async () => true),
    userHasCrossSigningKeys: vi.fn(async () => true),
    getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
  });

  await bootstrapper.bootstrap(crypto, {
    strict: true,
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    allowAutomaticCrossSigningReset: false,
  });

  return { deps, crypto, bootstrapCrossSigning };
}

function expectSecretStorageRepairRetry(
  deps: ReturnType<typeof createBootstrapperDeps>,
  crypto: MatrixCryptoBootstrapApi,
  bootstrapCrossSigning: BootstrapCrossSigningMock,
) {
  expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(crypto, {
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    forceNewSecretStorage: true,
  });
  expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
}

function createForcedResetHarness(bootstrapCrossSigning: BootstrapCrossSigningMock) {
  return createBootstrapperHarness({
    bootstrapCrossSigning,
    isCrossSigningReady: vi.fn(async () => true),
    userHasCrossSigningKeys: vi.fn(async () => true),
    getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
  });
}

function expectForcedResetCrossSigningCalls(
  bootstrapCrossSigning: BootstrapCrossSigningMock,
  params: { setupNewCall: number; totalCalls: number },
) {
  expect(bootstrapCrossSigning).toHaveBeenCalledTimes(params.totalCalls);
  expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
    params.setupNewCall,
    expect.objectContaining({
      setupNewCrossSigning: true,
      authUploadDeviceSigningKeys: expect.any(Function),
    }),
  );
  expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
    params.totalCalls,
    expect.objectContaining({
      authUploadDeviceSigningKeys: expect.any(Function),
    }),
  );
}

async function bootstrapWithVerificationRequestListener(overrides?: {
  deps?: Partial<ReturnType<typeof createBootstrapperDeps>>;
  crypto?: Partial<MatrixCryptoBootstrapApi>;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const { deps, bootstrapper, crypto } = createBootstrapperHarness(
    {
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        listeners.set(eventName, listener);
      }),
      ...overrides?.crypto,
    },
    overrides?.deps,
  );

  await bootstrapper.bootstrap(crypto);
  const listener = Array.from(listeners.entries()).find(([eventName]) =>
    eventName.toLowerCase().includes("verificationrequest"),
  )?.[1];
  expect(listener).toBeTypeOf("function");

  return {
    deps,
    listener,
  };
}

describe("MatrixCryptoBootstrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps cross-signing/secret-storage and binds decrypt retry signals", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: false,
      },
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledTimes(2);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledWith(crypto);
  });

  it("forces new cross-signing keys only when readiness check still fails", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      isCrossSigningReady: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      userHasCrossSigningKeys: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("does not auto-reset cross-signing when automatic reset is disabled", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    expect(bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("does not mark the own Matrix identity verified before cross-signing the current device", async () => {
    const verifyOwnIdentity = vi.fn(async () => undefined);
    const freeOwnIdentity = vi.fn();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const getDeviceVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce({
        isVerified: () => false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: true,
      })
      .mockResolvedValueOnce({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      });
    const { bootstrapper, crypto } = createBootstrapperHarness({
      crossSignDevice,
      getDeviceVerificationStatus,
      getOwnIdentity: vi.fn(async () => ({
        free: freeOwnIdentity,
        isVerified: () => false,
        verify: verifyOwnIdentity,
      })),
      isCrossSigningReady: vi.fn(async () => true),
      setDeviceVerified,
      userHasCrossSigningKeys: vi.fn(async () => true),
    });

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(verifyOwnIdentity).not.toHaveBeenCalled();
    expect(freeOwnIdentity).not.toHaveBeenCalled();
    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
  });

  it("refreshes published cross-signing keys before importing private keys from secret storage", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const userHasCrossSigningKeys = vi.fn(async () => true);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys,
    });

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(userHasCrossSigningKeys).toHaveBeenCalledWith("@bot:example.org", true);
    expect(userHasCrossSigningKeys.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrapCrossSigning.mock.invocationCallOrder[0],
    );
  });

  it("passes explicit secret-storage repair allowance only when requested", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      },
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits a stale server key", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "getSecretStorageKey callback returned falsey",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits bad MAC", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "Error decrypting secret m.cross_signing.master: bad MAC",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
  });

  it("does not mutate secret storage before forced repair fails on password UIA without a password", async () => {
    const deps = createBootstrapperDeps();
    deps.getPassword = vi.fn<() => string | undefined>(() => undefined);
    const bootstrapCrossSigning = vi.fn<
      ({
        authUploadDeviceSigningKeys,
      }: {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      await authUploadDeviceSigningKeys?.(async (authData) => {
        if (authData === null) {
          throw uiaError({ flows: [{ stages: ["m.login.password"] }], session: "sess-1" });
        }
        return undefined;
      });
    });
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await expect(
      bootstrapper.bootstrap(crypto, {
        strict: true,
        forceResetCrossSigning: true,
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      }),
    ).rejects.toThrow(MatrixUiaUnsupportedStagesError);

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
  });

  it("recreates secret storage and retries a forced reset when stale server SSSS blocks it", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("getSecretStorageKey callback returned falsey"))
      .mockResolvedValueOnce(undefined);
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        forceNewSecretStorage: true,
      },
    );
    expectForcedResetCrossSigningCalls(bootstrapCrossSigning, {
      setupNewCall: 2,
      totalCalls: 3,
    });
  });

  it("re-exports cross-signing keys after forced reset creates secret storage", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      },
    );
    expectForcedResetCrossSigningCalls(bootstrapCrossSigning, {
      setupNewCall: 1,
      totalCalls: 2,
    });
  });

  it("trusts the fresh own identity after a forced cross-signing reset", async () => {
    const verifyOwnIdentity = vi.fn(async () => ({}));
    const freeOwnIdentity = vi.fn();
    const { crypto, bootstrapper } = createForcedResetHarness(vi.fn(async () => {}));
    crypto.getOwnIdentity = vi.fn(async () => ({
      free: freeOwnIdentity,
      isVerified: () => false,
      verify: verifyOwnIdentity,
    }));

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
    });

    expect(verifyOwnIdentity).toHaveBeenCalledTimes(1);
    expect(freeOwnIdentity).toHaveBeenCalledTimes(1);
  });

  it("does not trust an existing unpublished identity without a reset", async () => {
    const verifyOwnIdentity = vi.fn(async () => ({}));
    const { crypto, bootstrapper } = createBootstrapperHarness({
      bootstrapCrossSigning: vi.fn(async () => {}),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      getOwnIdentity: vi.fn(async () => ({
        isVerified: () => false,
        verify: verifyOwnIdentity,
      })),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
    });

    const result = await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
      strict: false,
    });

    expect(result.crossSigningPublished).toBe(false);
    expect(verifyOwnIdentity).not.toHaveBeenCalled();
  });

  it("fails in strict mode when cross-signing keys are still unpublished", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      bootstrapCrossSigning: vi.fn(async () => {}),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await expect(bootstrapper.bootstrap(crypto, { strict: true })).rejects.toThrow(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
  });

  it("uses password UIA fallback when the homeserver requires m.login.password", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });

    await bootstrapper.bootstrap(crypto);

    const bootstrapCrossSigningCalls = bootstrapCrossSigning.mock.calls as Array<
      [
        {
          authUploadDeviceSigningKeys?: <T>(
            makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
          ) => Promise<T>;
        }?,
      ]
    >;
    const authUploadDeviceSigningKeys =
      bootstrapCrossSigningCalls[0]?.[0]?.authUploadDeviceSigningKeys;
    expect(authUploadDeviceSigningKeys).toBeTypeOf("function");

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys?.(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaError({
          flows: [{ stages: ["m.login.password"] }],
          session: "sess-pw",
        });
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
        session: "sess-pw",
      },
    ]);
  });

  it("uses dummy UIA stage when advertised even alongside other stages", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    await bootstrapper.bootstrap(crypto);

    const callback = (bootstrapCrossSigning.mock.calls[0]?.[0] as {
      authUploadDeviceSigningKeys?: <T>(
        makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
      ) => Promise<T>;
    } | undefined)?.authUploadDeviceSigningKeys;
    expect(callback).toBeTypeOf("function");

    const seen: Array<Record<string, unknown> | null> = [];
    const result = await callback?.(async (authData) => {
      seen.push(authData);
      if (authData === null) {
        throw uiaError({
          flows: [{ stages: ["m.login.dummy"] }, { stages: ["m.login.password"] }],
          session: "sess-dummy",
        });
      }
      if (authData.type === "m.login.dummy") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seen).toEqual([null, { type: "m.login.dummy", session: "sess-dummy" }]);
  });

  it("surfaces MatrixCrossSigningResetRequiredError with the MAS reset URL", async () => {
    const masUrl = "https://mas.example.org/account/cross_signing_reset?token=abc";
    const bootstrapCrossSigning = vi.fn<
      (opts: {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      await authUploadDeviceSigningKeys?.(async (authData) => {
        if (authData === null) {
          throw uiaError({
            flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
            session: "sess-mas",
            params: {
              "org.matrix.cross_signing_reset": { url: masUrl },
            },
          });
        }
        return undefined;
      });
    });
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, {
        strict: true,
        forceResetCrossSigning: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MatrixCrossSigningResetRequiredError);
    const resetErr = caught as MatrixCrossSigningResetRequiredError;
    expect(resetErr.resetUrl).toBe(masUrl);
    expect(resetErr.session).toBe("sess-mas");
    expect(resetErr.stages).toContain("org.matrix.cross_signing_reset");
    expect(resetErr.message).toContain(masUrl);
  });

  it("attempts forced reset on MAS so a freshly approved reset can land within the MAS window", async () => {
    // The bot does not know whether the operator has just approved the
    // org.matrix.cross_signing_reset action in MAS. The only way to find out
    // is to attempt the upload. When approval is current the upload returns
    // 200; when it is not, Synapse returns 401 with the MAS reset stage and
    // the UIA callback rethrows MatrixCrossSigningResetRequiredError. Either
    // way the bot must call bootstrapCrossSigning rather than short-circuit.
    const masResetUrl = "https://mas.example.org/account/?action=org.matrix.cross_signing_reset";
    const bootstrapCrossSigning = vi.fn<
      (opts: {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      await authUploadDeviceSigningKeys?.(async (authData) => {
        if (authData === null) {
          throw uiaError({
            flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
            session: "sess-mas-not-approved",
            params: { "org.matrix.cross_signing_reset": { url: masResetUrl } },
          });
        }
        return undefined;
      });
    });
    const getHomeserverCapabilities = vi.fn(async () => ({
      msAuthService: true,
      accountManagementUri: "https://mas.example.org/account/",
    }));
    const { bootstrapper, crypto } = createBootstrapperHarness(
      {
        bootstrapCrossSigning,
        userHasCrossSigningKeys: vi.fn(async () => true),
        isCrossSigningReady: vi.fn(async () => true),
        getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      },
      { getHomeserverCapabilities },
    );

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, {
        strict: true,
        forceResetCrossSigning: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MatrixCrossSigningResetRequiredError);
    expect((caught as MatrixCrossSigningResetRequiredError).resetUrl).toBe(masResetUrl);
    // Did attempt the upload, because we cannot tell from outside whether
    // MAS approval is current.
    expect(bootstrapCrossSigning).toHaveBeenCalled();
  });

  it("allows MSC3967 first-publish on MAS when the user has no master key yet", async () => {
    const bootstrapCrossSigning = vi.fn<
      (opts: {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      const result = await authUploadDeviceSigningKeys?.(async (authData) => {
        // MSC3967: server accepts the first upload with no auth.
        return authData === null ? "ok" : "fail";
      });
      expect(result).toBe("ok");
    });
    const userHasCrossSigningKeys = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false) // initial probe — no server master key yet
      .mockResolvedValue(true); // after upload — keys are now published
    const getHomeserverCapabilities = vi.fn(async () => ({ msAuthService: true }));
    const { bootstrapper, crypto } = createBootstrapperHarness(
      {
        bootstrapCrossSigning,
        userHasCrossSigningKeys,
        isCrossSigningReady: vi.fn(async () => true),
        getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      },
      { getHomeserverCapabilities },
    );

    const result = await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
    });

    expect(result.crossSigningPublished).toBe(true);
    expect(bootstrapCrossSigning).toHaveBeenCalled();
  });

  it("falls through to a reset upload after an import-key mismatch on MAS, surfacing the MAS URL on 401", async () => {
    // First-pass import fails (local secret-storage private key doesn't match
    // the server master pubkey). The bootstrap then falls through to a
    // setupNewCrossSigning upload — the same upload that, *post* MAS
    // approval, would land cross-signing successfully. Without approval, the
    // UIA callback turns Synapse's 401 into MatrixCrossSigningResetRequiredError
    // carrying the MAS reset URL constructed from the cached MSC2965
    // accountManagementUri.
    const bootstrapCrossSigning = vi
      .fn<
        (opts: {
          setupNewCrossSigning?: boolean;
          authUploadDeviceSigningKeys?: <T>(
            makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
          ) => Promise<T>;
        }) => Promise<void>
      >()
      .mockImplementationOnce(async () => {
        throw new Error(
          "Error while importing m.cross_signing.master: The public key of the imported private key doesn't match the public key that was uploaded to the server",
        );
      })
      .mockImplementationOnce(async ({ authUploadDeviceSigningKeys }) => {
        await authUploadDeviceSigningKeys?.(async (authData) => {
          if (authData === null) {
            throw uiaError({
              flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
              session: "sess-mas",
            });
          }
          return undefined;
        });
      });
    const getHomeserverCapabilities = vi.fn(async () => ({
      msAuthService: true,
      accountManagementUri: "https://auth.example.org/account/",
    }));
    const { bootstrapper, crypto } = createBootstrapperHarness(
      {
        bootstrapCrossSigning,
        userHasCrossSigningKeys: vi.fn(async () => true),
        isCrossSigningReady: vi.fn(async () => false),
        getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      },
      { getHomeserverCapabilities },
    );

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, { strict: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MatrixCrossSigningResetRequiredError);
    expect((caught as MatrixCrossSigningResetRequiredError).resetUrl).toBe(
      "https://auth.example.org/account/?action=org.matrix.cross_signing_reset",
    );
    // First call was the no-reset attempt; second was the reset upload that hit MAS UIA.
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ setupNewCrossSigning: true }),
    );
  });

  it("resets cross-signing when first bootstrap attempt throws", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(undefined);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("marks own device verified and cross-signs it when needed", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
      setDeviceVerified,
      crossSignDevice,
      isCrossSigningReady: vi.fn(async () => true),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
  });

  it("does not treat local-only trust as sufficient for own-device bootstrap", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const getDeviceVerificationStatus = vi
      .fn<
        () => Promise<{
          isVerified: () => boolean;
          localVerified: boolean;
          crossSigningVerified: boolean;
          signedByOwner: boolean;
        }>
      >()
      .mockResolvedValueOnce({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: false,
      })
      .mockResolvedValueOnce({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      });
    const crypto = createCryptoApi({
      getDeviceVerificationStatus,
      setDeviceVerified,
      crossSignDevice,
      isCrossSigningReady: vi.fn(async () => true),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
    expect(getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("tracks incoming verification requests from other users", async () => {
    const { deps, listener } = await bootstrapWithVerificationRequestListener();
    const verificationRequest = {
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      accept: vi.fn(async () => {}),
    };
    listener?.(verificationRequest);

    expect(deps.verificationManager.trackVerificationRequest).toHaveBeenCalledWith(
      verificationRequest,
    );
    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("does not touch request state when tracking summary throws", async () => {
    const { listener } = await bootstrapWithVerificationRequestListener({
      deps: {
        verificationManager: {
          trackVerificationRequest: vi.fn(() => {
            throw new Error("summary failure");
          }),
        },
      },
      crypto: {
        getDeviceVerificationStatus: vi.fn(async () => ({
          isVerified: () => true,
        })),
      },
    });

    const verificationRequest = {
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      accept: vi.fn(async () => {}),
    };
    listener?.(verificationRequest);

    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("registers verification listeners only once across repeated bootstrap calls", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);
    await bootstrapper.bootstrap(crypto);

    expect(crypto.on).toHaveBeenCalledTimes(1);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledTimes(1);
  });
});
