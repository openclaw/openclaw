import { expectDefined } from "@openclaw/normalization-core";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { MatrixCryptoBootstrapper, type MatrixCryptoBootstrapOptions } from "./crypto-bootstrap.js";
import { createMatrixCryptoApi, MockVerificationRequest } from "./crypto.test-support.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";
import { MatrixVerificationManager } from "./verification-manager.js";

const forcedReset = {
  strict: true,
  forceResetCrossSigning: true,
  allowSecretStorageRecreateWithoutRecoveryKey: true,
};
function createDeps() {
  const recoveryKeyStore = new MatrixRecoveryKeyStore();
  vi.spyOn(recoveryKeyStore, "bootstrapSecretStorageWithRecoveryKey").mockResolvedValue();
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getPassword: vi.fn<() => string | undefined>(() => "super-secret-password"),
    canUnlockSecretStorage: vi.fn(async () => true),
    getDeviceId: vi.fn(() => "DEVICE123"),
    verificationManager: new MatrixVerificationManager(),
    recoveryKeyStore,
    decryptBridge: { bindCryptoRetrySignals: vi.fn() },
  };
}
function verifiedDevice(overrides?: { crossSigningVerified?: boolean }) {
  return {
    isVerified: () => true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    ...overrides,
  };
}
function ownIdentity() {
  return { free: vi.fn(), isVerified: () => false, verify: vi.fn(async () => ({})) };
}

describe("MatrixCryptoBootstrapper", () => {
  let deps: ReturnType<typeof createDeps>;
  let crypto: Mocked<MatrixCryptoBootstrapApi>;
  let bootstrapper: MatrixCryptoBootstrapper<MatrixRawEvent>;
  const bootstrap = (options?: MatrixCryptoBootstrapOptions) =>
    bootstrapper.bootstrap(crypto, options);
  const expectCrossSigningCall = (count: number, setupNewCrossSigning?: boolean) => {
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(count);
    expect(crypto.bootstrapCrossSigning).toHaveBeenNthCalledWith(
      count,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
        ...(setupNewCrossSigning === undefined ? {} : { setupNewCrossSigning }),
      }),
    );
  };
  beforeEach(() => {
    vi.restoreAllMocks();
    deps = createDeps();
    crypto = vi.mocked(createMatrixCryptoApi());
    bootstrapper = new MatrixCryptoBootstrapper(deps);
  });

  it("does not auto-reset cross-signing when automatic reset is disabled", async () => {
    const identity = ownIdentity();
    crypto.getOwnIdentity.mockResolvedValue(identity);
    crypto.isCrossSigningReady.mockResolvedValue(false);
    crypto.userHasCrossSigningKeys.mockResolvedValue(false);
    crypto.getDeviceVerificationStatus.mockResolvedValue(
      verifiedDevice({ crossSigningVerified: false }),
    );
    expect(
      (await bootstrap({ allowAutomaticCrossSigningReset: false })).crossSigningPublished,
    ).toBe(false);
    expect(identity.verify).not.toHaveBeenCalled();
    expectCrossSigningCall(1);
  });

  it("does not mark the own Matrix identity verified before cross-signing the current device", async () => {
    const identity = ownIdentity();
    crypto.getOwnIdentity.mockResolvedValue(identity);
    crypto.getDeviceVerificationStatus
      .mockResolvedValueOnce(verifiedDevice({ crossSigningVerified: false }))
      .mockResolvedValueOnce(verifiedDevice());
    await bootstrap({ allowAutomaticCrossSigningReset: false });
    expect(identity.verify).not.toHaveBeenCalled();
    expect(identity.free).not.toHaveBeenCalled();
    expect(crypto.setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crypto.crossSignDevice).toHaveBeenCalledWith("DEVICE123");
    expect(crypto.getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits bad MAC", async () => {
    crypto.bootstrapCrossSigning.mockRejectedValueOnce(
      new Error("Error decrypting secret m.cross_signing.master: bad MAC"),
    );
    crypto.getDeviceVerificationStatus.mockResolvedValue(verifiedDevice());
    await bootstrap({
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
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(2);
  });

  it("does not mutate secret storage before forced repair fails on password UIA without a password", async () => {
    deps.getPassword.mockReturnValue(undefined);
    crypto.getDeviceVerificationStatus.mockResolvedValue(verifiedDevice());
    crypto.bootstrapCrossSigning.mockImplementation(
      async ({ authUploadDeviceSigningKeys } = {}) => {
        await authUploadDeviceSigningKeys?.(async (authData) => {
          if (authData === null) {
            throw new Error("need auth");
          }
          if (authData.type === "m.login.dummy") {
            throw new Error("dummy rejected");
          }
        });
      },
    );
    await expect(bootstrap(forcedReset)).rejects.toThrow(
      "Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback",
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1);
  });

  it("rejects forced reset before mutation when the active recovery key is unavailable", async () => {
    deps.canUnlockSecretStorage.mockResolvedValue(false);
    await expect(bootstrap(forcedReset)).rejects.toThrow(
      "Forced cross-signing reset requires the active Matrix recovery key; supply it before retrying",
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "never repairs locked SSSS after forced reset (strict=%s)",
    async (strict) => {
      crypto.bootstrapCrossSigning.mockRejectedValueOnce(
        new Error("getSecretStorageKey callback returned falsey"),
      );
      crypto.getDeviceVerificationStatus.mockResolvedValue(verifiedDevice());
      const result = bootstrap({ ...forcedReset, strict });
      if (strict) {
        await expect(result).rejects.toThrow(
          "Forced cross-signing reset cannot access secret storage; restore the Matrix recovery key before retrying",
        );
      } else {
        await expect(result).resolves.toEqual({
          crossSigningReady: false,
          crossSigningPublished: false,
          ownDeviceVerified: null,
        });
      }
      expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
      expectCrossSigningCall(1, true);
    },
  );

  it("trusts the fresh own identity after a forced cross-signing reset", async () => {
    const identity = ownIdentity();
    crypto.getOwnIdentity.mockResolvedValue(identity);
    crypto.getDeviceVerificationStatus.mockResolvedValue(verifiedDevice());
    await bootstrap(forcedReset);
    expect(identity.verify).toHaveBeenCalledTimes(1);
    expect(identity.free).toHaveBeenCalledTimes(1);
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledOnce();
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      { allowSecretStorageRecreateWithoutRecoveryKey: true },
    );
    expectCrossSigningCall(1, true);
  });

  it("uses password UIA fallback when null and dummy auth fail", async () => {
    await bootstrap();
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith("@bot:example.org", true);
    expect(
      expectDefined(
        crypto.userHasCrossSigningKeys.mock.invocationCallOrder[0],
        "cross-signing lookup",
      ),
    ).toBeLessThan(
      expectDefined(
        crypto.bootstrapCrossSigning.mock.invocationCallOrder[0],
        "cross-signing bootstrap",
      ),
    );
    const auth = expectDefined(
      crypto.bootstrapCrossSigning.mock.calls[0]?.[0]?.authUploadDeviceSigningKeys,
      "UIA callback",
    );
    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    expect(
      await auth(async (authData) => {
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
      }),
    ).toBe("ok");
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
    crypto.bootstrapCrossSigning.mockRejectedValueOnce(new Error("first attempt failed"));
    await bootstrap();
    expectCrossSigningCall(2, true);
  });

  it("does not touch request state when tracking summary throws", async () => {
    vi.spyOn(deps.verificationManager, "trackVerificationRequest").mockImplementation(() => {
      throw new Error("summary failure");
    });
    await bootstrap();
    const listener = expectDefined(
      crypto.on.mock.calls.find(
        ([event]) => event === CryptoEvent.VerificationRequestReceived,
      )?.[1],
      "verification listener",
    );
    const request = new MockVerificationRequest();
    listener(request);
    expect(request.accept).not.toHaveBeenCalled();
  });

  it("registers verification listeners only once across repeated bootstrap calls", async () => {
    await bootstrap();
    await bootstrap();
    expect(crypto.on).toHaveBeenCalledTimes(1);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledTimes(1);
  });
});
