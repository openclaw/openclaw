import { beforeEach, describe, expect, it, vi } from "vitest";

const withResolvedActionClientMock = vi.fn();
const withStartedActionClientMock = vi.fn();

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

const {
  listMatrixVerifications,
  getMatrixEncryptionStatus,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  restoreMatrixRoomKeyBackup,
  runMatrixSelfVerification,
  startMatrixVerification,
  confirmMatrixVerificationSas,
} = await import("./verification.js");

function useStartedClient(client: unknown) {
  withStartedActionClientMock.mockImplementation(async (_opts, run) => run(client));
}

function useResolvedClient(client: unknown) {
  withResolvedActionClientMock.mockImplementation(async (_opts, run) => run(client));
}

function expectResolvedActionClientReadinessNone(): void {
  expect(withResolvedActionClientMock.mock.calls[0]).toEqual([
    expect.objectContaining({ readiness: "none" }),
    expect.any(Function),
  ]);
}

describe("matrix verification actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createVerificationStages() {
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
      sas: { decimal: [1, 2, 3] },
    };
    return { requested, sas, completed: { ...sas, completed: true, phaseName: "done" } };
  }

  function mockCompletedSelfVerificationCrypto() {
    const { requested, sas, completed } = createVerificationStages();
    return {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
  }

  function runSelfVerification(timeoutMs = 500, matched = true) {
    return runMatrixSelfVerification({ confirmSas: vi.fn(async () => matched), timeoutMs });
  }

  function mockDeviceStatus(serverDeviceKnown: boolean) {
    return {
      ...mockVerifiedOwnerStatus(serverDeviceKnown),
      serverDeviceKnown,
    };
  }

  function mockVerifiedOwnerStatus(verified = true) {
    return {
      crossSigningVerified: verified,
      deviceId: "DEVICE123",
      localVerified: verified,
      signedByOwner: verified,
      verified,
    };
  }

  function mockCrossSigningPublicationStatus(published = true) {
    return { published };
  }

  function mockTrustClient(
    verification = mockVerifiedOwnerStatus(),
    published = true,
    error?: string,
  ) {
    const crossSigning = mockCrossSigningPublicationStatus(published);
    return {
      bootstrapOwnDeviceVerification: vi.fn(async () => ({
        crossSigning,
        success: published,
        verification,
        ...(error ? { error } : {}),
      })),
      getOwnCrossSigningPublicationStatus: vi.fn(async () => crossSigning),
      getOwnDeviceVerificationStatus: vi.fn(async () => verification),
    };
  }

  function expectVerified(result: unknown, includeId = false) {
    expect(result).toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
      ownerVerification: { verified: true },
      ...(includeId ? { id: "verification-1" } : {}),
    });
  }

  function expectCancelled(cancel: ReturnType<typeof vi.fn>) {
    expect(cancel).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  }

  it("uses the resolved default Matrix account when accountId is omitted", async () => {
    const cfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: { ops: { encryption: false } },
        },
      },
    };
    useStartedClient({ crypto: null });

    await expect(listMatrixVerifications({ cfg })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("refreshes own-device keys before resolving authoritative verification status", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const refreshOwnDeviceKeys = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const getOwnDeviceVerificationStatus = vi.fn().mockResolvedValue(mockDeviceStatus(true));
    useResolvedClient({
      prepareForOneOff,
      refreshOwnDeviceKeys,
      crypto: {
        listVerifications: vi.fn(async () => []),
        getRecoveryKey: vi.fn(async () => ({
          encodedPrivateKey: "rec-key",
        })),
      },
      getOwnDeviceVerificationStatus,
      start,
    });

    const status = await getMatrixVerificationStatus({ includeRecoveryKey: true });

    expect(status).toMatchObject({
      verified: true,
      pendingVerifications: 0,
      recoveryKey: "rec-key",
    });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expectResolvedActionClientReadinessNone();
    expect(prepareForOneOff).toHaveBeenCalledTimes(1);
    expect(refreshOwnDeviceKeys).toHaveBeenCalledTimes(1);
    const finalStatusReadOrder = getOwnDeviceVerificationStatus.mock.invocationCallOrder[1];
    if (finalStatusReadOrder === undefined) {
      throw new Error("expected a final Matrix verification status read");
    }
    expect(refreshOwnDeviceKeys.mock.invocationCallOrder[0]).toBeLessThan(finalStatusReadOrder);
    expect(start).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("fails closed before local Matrix prep when the current device is gone", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const getOwnDeviceVerificationStatus = vi.fn(async () => mockDeviceStatus(false));
    useResolvedClient({
      crypto: {
        listVerifications: vi.fn(async () => []),
      },
      getOwnDeviceVerificationStatus,
      prepareForOneOff,
    });

    const status = await getMatrixVerificationStatus();

    expect(status).toMatchObject({
      deviceId: "DEVICE123",
      serverDeviceKnown: false,
      pendingVerifications: 0,
    });
    expectResolvedActionClientReadinessNone();
    expect(prepareForOneOff).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
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
            trusted: true,
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
    expect(backup).toMatchObject({ serverVersion: "11", trusted: true });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("restores room-key backup without startup crypto auto-repair", async () => {
    const restoreRoomKeyBackup = vi.fn(async () => ({
      success: true,
      imported: 1,
      total: 1,
    }));
    useResolvedClient({ restoreRoomKeyBackup });

    const restored = await restoreMatrixRoomKeyBackup({ recoveryKey: " key " });

    expect(restored.success).toBe(true);
    expect(restoreRoomKeyBackup).toHaveBeenCalledWith({ recoveryKey: "key" });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("rehydrates DM verification requests before follow-up actions", async () => {
    const tracked = { ...createVerificationStages().requested, transactionId: "txn-dm" };
    const started = {
      ...tracked,
      chosenMethod: "m.sas.v1",
      phaseName: "started",
    };
    const crypto = {
      ensureVerificationDmTracked: vi.fn(async () => tracked),
      startVerification: vi.fn(async () => started),
    };
    useStartedClient({ crypto });

    const result = await startMatrixVerification("txn-dm", {
      verificationDmRoomId: "!dm:example.org",
      verificationDmUserId: "@alice:example.org",
    });

    expect(result).toMatchObject({ id: "verification-1", phaseName: "started" });

    expect(crypto.ensureVerificationDmTracked).toHaveBeenCalledWith({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });
    expect(crypto.startVerification).toHaveBeenCalledWith("txn-dm", "sas");
  });

  it("requires complete DM lookup details for verification follow-up actions", async () => {
    const crypto = {
      ensureVerificationDmTracked: vi.fn(),
      startVerification: vi.fn(),
    };
    useStartedClient({ crypto });

    await expect(
      startMatrixVerification("txn-dm", {
        verificationDmRoomId: "!dm:example.org",
      }),
    ).rejects.toThrow("--user-id and --room-id must be provided together");

    expect(crypto.ensureVerificationDmTracked).not.toHaveBeenCalled();
    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("keeps self-verification in one started Matrix client session", async () => {
    const { requested } = createVerificationStages();
    const ready = { ...requested, phaseName: "ready" };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: { emoji: [["🐶", "Dog"]] },
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
    const getOwnDeviceIdentityVerificationStatus = vi.fn(
      async () => await new Promise<never>(() => {}),
    );
    const trust = mockTrustClient();
    useStartedClient({ ...trust, crypto, getOwnDeviceIdentityVerificationStatus });

    const result = await runMatrixSelfVerification({ confirmSas, timeoutMs: 500 });

    expectVerified(result, true);

    expect(withStartedActionClientMock).toHaveBeenCalledTimes(1);
    expect(crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
    expect(crypto.startVerification).toHaveBeenCalledWith("verification-1", "sas");
    expect(confirmSas).toHaveBeenCalledWith(sas.sas, sas);
    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-1");
    expect(trust.bootstrapOwnDeviceVerification).not.toHaveBeenCalled();
    expect(trust.getOwnCrossSigningPublicationStatus).toHaveBeenCalledTimes(1);
    expect(trust.getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
    expect(getOwnDeviceIdentityVerificationStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["full identity trust", false, true, 1],
    ["published cross-signing keys", true, false, 0],
  ] as const)(
    "waits for %s after SAS completes",
    async (_name, verified, published, trustCalls) => {
      const crypto = mockCompletedSelfVerificationCrypto();
      const trust = mockTrustClient(mockVerifiedOwnerStatus(verified), published);
      trust.getOwnDeviceVerificationStatus
        .mockReset()
        .mockResolvedValueOnce(mockVerifiedOwnerStatus(verified))
        .mockResolvedValueOnce(mockVerifiedOwnerStatus());
      trust.getOwnCrossSigningPublicationStatus
        .mockReset()
        .mockResolvedValueOnce(mockCrossSigningPublicationStatus(published))
        .mockResolvedValueOnce(mockCrossSigningPublicationStatus(true));
      const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
      useStartedClient({ ...trust, crypto, trustOwnIdentityAfterSelfVerification });

      const result = await runSelfVerification();

      expectVerified(result);

      expect(trust.getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
      expect(trust.getOwnCrossSigningPublicationStatus).toHaveBeenCalledTimes(2);
      expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(trustCalls);
    },
  );

  it("waits for SAS data without restarting an already-started self-verification", async () => {
    const { requested, sas, completed } = createVerificationStages();
    const started = {
      ...requested,
      phaseName: "started",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn().mockResolvedValueOnce([started]).mockResolvedValueOnce([sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(),
    };
    useStartedClient({ ...mockTrustClient(), crypto });

    const result = await runSelfVerification();

    expect(result).toMatchObject({ completed: true, deviceOwnerVerified: true });

    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("fails immediately when an already-started self-verification uses a non-SAS method", async () => {
    const { requested } = createVerificationStages();
    const started = {
      ...requested,
      chosenMethod: "m.reciprocate.v1",
      phaseName: "started",
    };
    const cancelled = { ...started, phaseName: "cancelled" };
    const crypto = {
      cancelVerification: vi.fn(async () => cancelled),
      listVerifications: vi.fn(async () => [started]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(),
    };
    useStartedClient({ crypto });

    await expect(runSelfVerification()).rejects.toThrow(
      "Matrix self-verification started without SAS while waiting to show SAS emoji or decimals (method: m.reciprocate.v1)",
    );

    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expect(crypto.startVerification).not.toHaveBeenCalled();
    expectCancelled(crypto.cancelVerification);
  });

  it("finalizes completed non-SAS self-verification without waiting for SAS", async () => {
    const completed = {
      ...createVerificationStages().requested,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => completed),
      startVerification: vi.fn(),
    };
    const confirmSas = vi.fn(async () => true);
    useStartedClient({ ...mockTrustClient(), crypto });

    const result = await runMatrixSelfVerification({ confirmSas, timeoutMs: 500 });

    expect(result).toMatchObject({
      completed: true,
      deviceOwnerVerified: true,
      id: "verification-1",
    });

    expect(crypto.listVerifications).not.toHaveBeenCalled();
    expect(crypto.startVerification).not.toHaveBeenCalled();
    expect(crypto.confirmVerificationSas).not.toHaveBeenCalled();
    expect(confirmSas).not.toHaveBeenCalled();
  });

  it("fails self-verification if SAS completes but full identity trust cannot be established", async () => {
    const crypto = { ...mockCompletedSelfVerificationCrypto(), cancelVerification: vi.fn() };
    const trust = mockTrustClient(
      mockVerifiedOwnerStatus(false),
      false,
      "cross-signing identity is still not trusted",
    );
    useStartedClient({
      ...trust,
      crypto,
      trustOwnIdentityAfterSelfVerification: vi.fn(async () => {}),
    });

    await expect(runSelfVerification(30)).rejects.toThrow(
      "Timed out waiting for Matrix self-verification to establish full Matrix identity trust",
    );

    expect(crypto.cancelVerification).not.toHaveBeenCalled();
    expect(trust.bootstrapOwnDeviceVerification).not.toHaveBeenCalled();
  });

  it("cancels the pending self-verification request when acceptance times out", async () => {
    const { requested } = createVerificationStages();
    const crypto = {
      cancelVerification: vi.fn(async () => requested),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => requested),
    };
    useStartedClient({ crypto });

    await expect(runSelfVerification(30)).rejects.toThrow(
      "Timed out waiting for Matrix self-verification to be accepted",
    );

    expectCancelled(crypto.cancelVerification);
  });

  it("fails immediately when the self-verification request is cancelled while waiting", async () => {
    const { requested } = createVerificationStages();
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
    useStartedClient({ crypto });

    await expect(runSelfVerification()).rejects.toThrow(
      "Matrix self-verification was cancelled: Remote cancelled",
    );

    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expectCancelled(crypto.cancelVerification);
  });

  it("cancels the request when SAS mismatch submission fails", async () => {
    const { sas } = createVerificationStages();
    const crypto = {
      cancelVerification: vi.fn(async () => sas),
      listVerifications: vi.fn(async () => [sas]),
      mismatchVerificationSas: vi.fn(async () => {
        throw new Error("failed to send SAS mismatch");
      }),
      requestVerification: vi.fn(async () => sas),
    };
    useStartedClient({ crypto });

    await expect(runSelfVerification(500, false)).rejects.toThrow("failed to send SAS mismatch");

    expectCancelled(crypto.cancelVerification);
  });

  it.each([
    [true, true, undefined, 1],
    [false, true, undefined, 0],
    [true, false, "verifier rejected mid-protocol", 0],
  ] as const)(
    "SAS confirmation: self=%s completed=%s error=%s",
    async (isSelfVerification, completed, error, trustCalls) => {
      const id = isSelfVerification ? "verification-self" : "verification-remote";
      const crypto = {
        confirmVerificationSas: vi.fn(async () => ({
          ...createVerificationStages().completed,
          id,
          isSelfVerification,
          completed,
          error,
          phaseName: completed ? "done" : "started",
          transactionId: isSelfVerification ? "tx-self" : "tx-remote",
        })),
      };
      const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
      useStartedClient({ crypto, trustOwnIdentityAfterSelfVerification });
      expect(await confirmMatrixVerificationSas(id)).toMatchObject({ isSelfVerification, error });
      expect(crypto.confirmVerificationSas).toHaveBeenCalledWith(id);
      expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(trustCalls);
    },
  );
});
