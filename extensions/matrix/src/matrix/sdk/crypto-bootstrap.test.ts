import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MatrixCryptoBootstrapper } from "./crypto-bootstrap.js";
import { createMatrixCryptoApi as createCryptoApi } from "./crypto.test-support.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";

type MatrixCryptoBootstrapperDeps<TRawEvent extends MatrixRawEvent> = ConstructorParameters<
  typeof MatrixCryptoBootstrapper<TRawEvent>
>[0];

type BootstrapCrossSigningMock = Mock<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
const forcedReset = {
  strict: true,
  forceResetCrossSigning: true,
  allowSecretStorageRecreateWithoutRecoveryKey: true,
};

function expectBootstrapCrossSigningCall(
  source: MockCallSource,
  callNumber: number,
  expected?: { setupNewCrossSigning?: boolean },
) {
  expect(source).toHaveBeenCalledTimes(callNumber);
  expect(source).toHaveBeenNthCalledWith(
    callNumber,
    expect.objectContaining({ authUploadDeviceSigningKeys: expect.any(Function), ...expected }),
  );
}

function createBootstrapperDeps() {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getPassword: vi.fn<() => string | undefined>(() => "super-secret-password"),
    canUnlockSecretStorage: vi.fn(async () => true),
    getDeviceId: vi.fn(() => "DEVICE123"),
    verificationManager: {
      trackVerificationRequest: vi.fn(),
    },
    recoveryKeyStore: {
      bootstrapSecretStorageWithRecoveryKey: vi.fn<
        MatrixRecoveryKeyStore["bootstrapSecretStorageWithRecoveryKey"]
      >(async () => {}),
    },
    decryptBridge: {
      bindCryptoRetrySignals: vi.fn(),
    },
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

const unverifiedDevice = () =>
  createVerifiedDeviceStatus({
    localVerified: false,
    crossSigningVerified: false,
    signedByOwner: false,
  });

function createOwnIdentity() {
  return { free: vi.fn(), isVerified: () => false, verify: vi.fn(async () => ({})) };
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

function createForcedResetHarness(bootstrapCrossSigning: BootstrapCrossSigningMock) {
  return createBootstrapperHarness({
    bootstrapCrossSigning,
    getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
  });
}

describe("MatrixCryptoBootstrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not auto-reset cross-signing when automatic reset is disabled", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const identity = createOwnIdentity();
    const { crypto, bootstrapper } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getOwnIdentity: vi.fn(async () => identity),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () =>
        createVerifiedDeviceStatus({ crossSigningVerified: false }),
      ),
    });

    const result = await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(result.crossSigningPublished).toBe(false);
    expect(identity.verify).not.toHaveBeenCalled();
    expectBootstrapCrossSigningCall(bootstrapCrossSigning, 1);
  });

  it("does not mark the own Matrix identity verified before cross-signing the current device", async () => {
    const identity = createOwnIdentity();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const getDeviceVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce(createVerifiedDeviceStatus({ crossSigningVerified: false }))
      .mockResolvedValueOnce(createVerifiedDeviceStatus());
    const { bootstrapper, crypto } = createBootstrapperHarness({
      crossSignDevice,
      getDeviceVerificationStatus,
      getOwnIdentity: vi.fn(async () => identity),
      setDeviceVerified,
    });

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(identity.verify).not.toHaveBeenCalled();
    expect(identity.free).not.toHaveBeenCalled();
    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
    expect(getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits bad MAC", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Error decrypting secret m.cross_signing.master: bad MAC"))
      .mockResolvedValueOnce(undefined);
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);
    await bootstrapper.bootstrap(crypto, {
      strict: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
      allowAutomaticCrossSigningReset: false,
    });
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        forceNewSecretStorage: true,
      },
    );
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
  });

  it("does not mutate secret storage before forced repair fails on password UIA without a password", async () => {
    const deps = createBootstrapperDeps();
    deps.getPassword = vi.fn<() => string | undefined>(() => undefined);
    const bootstrapCrossSigning = vi.fn<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>(
      async ({
        authUploadDeviceSigningKeys,
      }: Parameters<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>[0] = {}) => {
        await authUploadDeviceSigningKeys?.(async (authData) => {
          if (authData === null) {
            throw new Error("need auth");
          }
          if (authData.type === "m.login.dummy") {
            throw new Error("dummy rejected");
          }
          return undefined;
        });
      },
    );
    const { crypto, bootstrapper } = createBootstrapperHarness(
      {
        bootstrapCrossSigning,
        getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      },
      deps,
    );

    await expect(bootstrapper.bootstrap(crypto, forcedReset)).rejects.toThrow(
      "Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback",
    );

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
  });

  it("rejects forced reset before mutation when the active recovery key is unavailable", async () => {
    const deps = createBootstrapperDeps();
    deps.canUnlockSecretStorage = vi.fn(async () => false);
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { crypto, bootstrapper } = createBootstrapperHarness({ bootstrapCrossSigning }, deps);

    await expect(bootstrapper.bootstrap(crypto, forcedReset)).rejects.toThrow(
      "Forced cross-signing reset requires the active Matrix recovery key; supply it before retrying",
    );

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("fails closed without recreating SSSS when forced reset cannot unlock it", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("getSecretStorageKey callback returned falsey"));
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);

    await expect(bootstrapper.bootstrap(crypto, forcedReset)).rejects.toThrow(
      "Forced cross-signing reset cannot access secret storage; restore the Matrix recovery key before retrying",
    );

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expectBootstrapCrossSigningCall(bootstrapCrossSigning, 1, { setupNewCrossSigning: true });
  });

  it("does not repair SSSS after a non-strict forced reset failure", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {
      throw new Error("getSecretStorageKey callback returned falsey");
    });
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);

    const result = await bootstrapper.bootstrap(crypto, { ...forcedReset, strict: false });

    expect(result).toEqual({
      crossSigningReady: false,
      crossSigningPublished: false,
      ownDeviceVerified: null,
    });
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(bootstrapCrossSigning).toHaveBeenCalledOnce();
  });

  it("trusts the fresh own identity after a forced cross-signing reset", async () => {
    const identity = createOwnIdentity();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { deps, crypto, bootstrapper } = createForcedResetHarness(bootstrapCrossSigning);
    crypto.getOwnIdentity = vi.fn(async () => identity);

    await bootstrapper.bootstrap(crypto, forcedReset);

    expect(identity.verify).toHaveBeenCalledTimes(1);
    expect(identity.free).toHaveBeenCalledTimes(1);
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledOnce();
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      { allowSecretStorageRecreateWithoutRecoveryKey: true },
    );
    expectBootstrapCrossSigningCall(bootstrapCrossSigning, 1, { setupNewCrossSigning: true });
  });

  it("fails in strict mode when cross-signing keys are still unpublished", async () => {
    const { crypto, bootstrapper } = createBootstrapperHarness({
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => unverifiedDevice()),
    });

    await expect(bootstrapper.bootstrap(crypto, { strict: true })).rejects.toThrow(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
  });

  it("uses password UIA fallback when null and dummy auth fail", async () => {
    const bootstrapCrossSigning = vi.fn<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>(
      async () => {},
    );
    const userHasCrossSigningKeys = vi.fn(async () => true);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      userHasCrossSigningKeys,
      getDeviceVerificationStatus: vi.fn(async () => unverifiedDevice()),
    });

    await bootstrapper.bootstrap(crypto);

    expect(userHasCrossSigningKeys).toHaveBeenCalledWith("@bot:example.org", true);
    expect(
      expectDefined(userHasCrossSigningKeys.mock.invocationCallOrder[0], "cross-signing lookup"),
    ).toBeLessThan(
      expectDefined(bootstrapCrossSigning.mock.invocationCallOrder[0], "cross-signing bootstrap"),
    );
    const authUploadDeviceSigningKeys =
      bootstrapCrossSigning.mock.calls[0]?.[0]?.authUploadDeviceSigningKeys;
    expect(authUploadDeviceSigningKeys).toBeTypeOf("function");

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys?.(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw new Error("need auth");
      }
      if (authData.type === "m.login.dummy") {
        throw new Error("dummy rejected");
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      { type: "m.login.dummy" },
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
      },
    ]);
  });

  it("resets cross-signing when first bootstrap attempt throws", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(undefined);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => unverifiedDevice()),
    });

    await bootstrapper.bootstrap(crypto);

    expectBootstrapCrossSigningCall(bootstrapCrossSigning, 2, { setupNewCrossSigning: true });
  });

  it("does not touch request state when tracking summary throws", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const { bootstrapper, crypto } = createBootstrapperHarness(
      {
        getDeviceVerificationStatus: vi.fn(async () => unverifiedDevice()),
        on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
          listeners.set(eventName, listener);
        }),
      },
      {
        verificationManager: {
          trackVerificationRequest: vi.fn(() => {
            throw new Error("summary failure");
          }),
        },
      },
    );
    await bootstrapper.bootstrap(crypto);
    const listener = Array.from(listeners.entries()).find(([eventName]) =>
      eventName.toLowerCase().includes("verificationrequest"),
    )?.[1];
    expect(listener).toBeTypeOf("function");
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
    const { deps, crypto, bootstrapper } = createBootstrapperHarness({
      getDeviceVerificationStatus: vi.fn(async () => unverifiedDevice()),
    });

    await bootstrapper.bootstrap(crypto);
    await bootstrapper.bootstrap(crypto);

    expect(crypto.on).toHaveBeenCalledTimes(1);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledTimes(1);
  });
});
