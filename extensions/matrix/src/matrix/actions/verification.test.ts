import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const withResolvedActionClientMock = vi.fn();
const withStartedActionClientMock = vi.fn();
const loadConfigMock = vi.fn(() => ({
  channels: {
    matrix: {},
  },
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      loadConfig: loadConfigMock,
    },
  }),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

let listMatrixVerifications: typeof import("./verification.js").listMatrixVerifications;
let getMatrixEncryptionStatus: typeof import("./verification.js").getMatrixEncryptionStatus;
let getMatrixRoomKeyBackupStatus: typeof import("./verification.js").getMatrixRoomKeyBackupStatus;
let getMatrixVerificationStatus: typeof import("./verification.js").getMatrixVerificationStatus;
let runMatrixSelfVerification: typeof import("./verification.js").runMatrixSelfVerification;

describe("matrix verification actions", () => {
  beforeAll(async () => {
    ({
      getMatrixEncryptionStatus,
      getMatrixRoomKeyBackupStatus,
      getMatrixVerificationStatus,
      listMatrixVerifications,
      runMatrixSelfVerification,
    } = await import("./verification.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {},
      },
    });
  });

  function mockVerifiedOwnerStatus() {
    return {
      backup: {
        activeVersion: "1",
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
        matchesDecryptionKey: true,
        serverVersion: "1",
        trusted: true,
      },
      backupVersion: "1",
      crossSigningVerified: true,
      deviceId: "DEVICE123",
      localVerified: true,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: null,
      recoveryKeyStored: false,
      signedByOwner: true,
      userId: "@bot:example.org",
      verified: true,
    };
  }

  function mockUnverifiedOwnerStatus() {
    return {
      ...mockVerifiedOwnerStatus(),
      crossSigningVerified: false,
      localVerified: false,
      signedByOwner: false,
      verified: false,
    };
  }

  it("points encryption guidance at the selected Matrix account", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(
      listMatrixVerifications({ cfg: loadConfigMock(), accountId: "ops" }),
    ).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses the resolved default Matrix account when accountId is omitted", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ cfg: loadConfigMock() })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses explicit cfg instead of runtime config when crypto is unavailable", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("verification actions should not reload runtime config when cfg is provided");
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ cfg: explicitCfg, accountId: "ops" })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("resolves verification status without starting the Matrix client", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        crypto: {
          listVerifications: vi.fn(async () => []),
          getRecoveryKey: vi.fn(async () => ({
            encodedPrivateKey: "rec-key",
          })),
        },
        getOwnDeviceVerificationStatus: vi.fn(async () => ({
          encryptionEnabled: true,
          verified: true,
          userId: "@bot:example.org",
          deviceId: "DEVICE123",
          localVerified: true,
          crossSigningVerified: true,
          signedByOwner: true,
          recoveryKeyStored: true,
          recoveryKeyCreatedAt: null,
          recoveryKeyId: "SSSS",
          backupVersion: "11",
          backup: {
            serverVersion: "11",
            activeVersion: "11",
            trusted: true,
            matchesDecryptionKey: true,
            decryptionKeyCached: true,
            keyLoadAttempted: false,
            keyLoadError: null,
          },
        })),
      });
    });

    const status = await getMatrixVerificationStatus({ includeRecoveryKey: true });

    expect(status).toMatchObject({
      verified: true,
      pendingVerifications: 0,
      recoveryKey: "rec-key",
    });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("resolves encryption and backup status without starting the Matrix client", async () => {
    withResolvedActionClientMock
      .mockImplementationOnce(async (_opts, run) => {
        return await run({
          crypto: {
            getRecoveryKey: vi.fn(async () => ({
              encodedPrivateKey: "rec-key",
              createdAt: "2026-01-01T00:00:00.000Z",
            })),
            listVerifications: vi.fn(async () => [{ id: "req-1" }]),
          },
        });
      })
      .mockImplementationOnce(async (_opts, run) => {
        return await run({
          getRoomKeyBackupStatus: vi.fn(async () => ({
            serverVersion: "11",
            activeVersion: "11",
            trusted: true,
            matchesDecryptionKey: true,
            decryptionKeyCached: true,
            keyLoadAttempted: false,
            keyLoadError: null,
          })),
        });
      });

    const encryption = await getMatrixEncryptionStatus({ includeRecoveryKey: true });
    const backup = await getMatrixRoomKeyBackupStatus();

    expect(encryption).toMatchObject({
      encryptionEnabled: true,
      recoveryKeyStored: true,
      recoveryKey: "rec-key",
      pendingVerifications: 1,
    });
    expect(backup).toMatchObject({
      serverVersion: "11",
      trusted: true,
    });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("keeps self-verification in one started Matrix client session", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const ready = {
      ...requested,
      phaseName: "ready",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        emoji: [["🐶", "Dog"]],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const listVerifications = vi
      .fn()
      .mockResolvedValueOnce([ready])
      .mockResolvedValueOnce([completed]);
    const crypto = {
      confirmVerificationSas: vi.fn(async () => sas),
      listVerifications,
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const confirmSas = vi.fn(async () => true);
    const getOwnDeviceVerificationStatus = vi.fn(async () => mockVerifiedOwnerStatus());
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ bootstrapOwnDeviceVerification, crypto, getOwnDeviceVerificationStatus });
    });

    await expect(runMatrixSelfVerification({ confirmSas, timeoutMs: 500 })).resolves.toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
      id: "verification-1",
      ownerVerification: {
        verified: true,
      },
    });

    expect(withStartedActionClientMock).toHaveBeenCalledTimes(1);
    expect(crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
    expect(crypto.startVerification).toHaveBeenCalledWith("verification-1", "sas");
    expect(confirmSas).toHaveBeenCalledWith(sas.sas, sas);
    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-1");
    expect(bootstrapOwnDeviceVerification).toHaveBeenCalledWith({
      allowAutomaticCrossSigningReset: false,
      verifyOwnIdentity: true,
    });
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalled();
  });

  it("does not complete self-verification until the OpenClaw device has full Matrix identity trust", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const getOwnDeviceVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce(mockUnverifiedOwnerStatus())
      .mockResolvedValueOnce(mockVerifiedOwnerStatus());
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ bootstrapOwnDeviceVerification, crypto, getOwnDeviceVerificationStatus });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).resolves.toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
      ownerVerification: {
        verified: true,
      },
    });

    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("waits for SAS data without restarting an already-started self-verification", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const started = {
      ...requested,
      phaseName: "started",
    };
    const sas = {
      ...started,
      hasSas: true,
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn().mockResolvedValueOnce([started]).mockResolvedValueOnce([sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).resolves.toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
    });

    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("finalizes completed non-SAS self-verification without waiting for SAS", async () => {
    const completed = {
      completed: true,
      hasSas: false,
      id: "verification-1",
      phaseName: "done",
      transactionId: "tx-self",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => completed),
      startVerification: vi.fn(),
    };
    const confirmSas = vi.fn(async () => true);
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    await expect(runMatrixSelfVerification({ confirmSas, timeoutMs: 500 })).resolves.toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
      id: "verification-1",
    });

    expect(crypto.listVerifications).not.toHaveBeenCalled();
    expect(crypto.startVerification).not.toHaveBeenCalled();
    expect(crypto.confirmVerificationSas).not.toHaveBeenCalled();
    expect(confirmSas).not.toHaveBeenCalled();
  });

  it("allows completed self-verification when only backup health remains degraded", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: false,
      error: "Matrix room key backup is not trusted by this device",
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).resolves.toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
    });
  });

  it("fails self-verification if SAS completes but full identity trust cannot be established", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      cancelVerification: vi.fn(),
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      success: false,
      error: "cross-signing identity is still not trusted",
      verification: mockUnverifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnDeviceVerificationStatus: vi.fn(async () => mockUnverifiedOwnerStatus()),
      });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 30 }),
    ).rejects.toThrow(
      "Matrix self-verification completed, but full Matrix identity trust is still incomplete",
    );

    expect(crypto.cancelVerification).not.toHaveBeenCalled();
  });

  it("cancels the pending self-verification request when acceptance times out", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => requested),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => requested),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 30 }),
    ).rejects.toThrow("Timed out waiting for Matrix self-verification to be accepted");

    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("fails immediately when the self-verification request is cancelled while waiting", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const cancelled = {
      ...requested,
      error: "Remote cancelled",
      pending: false,
      phaseName: "cancelled",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => cancelled),
      listVerifications: vi.fn(async () => [cancelled]),
      requestVerification: vi.fn(async () => requested),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).rejects.toThrow("Matrix self-verification was cancelled: Remote cancelled");

    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("cancels the request when SAS mismatch submission fails", async () => {
    const sas = {
      completed: false,
      hasSas: true,
      id: "verification-1",
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
      transactionId: "tx-self",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => sas),
      listVerifications: vi.fn(async () => [sas]),
      mismatchVerificationSas: vi.fn(async () => {
        throw new Error("failed to send SAS mismatch");
      }),
      requestVerification: vi.fn(async () => sas),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => false), timeoutMs: 500 }),
    ).rejects.toThrow("failed to send SAS mismatch");

    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });
});
