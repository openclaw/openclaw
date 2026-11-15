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

const returns = <T>(value: T) => vi.fn(async () => value);
function expectUnused(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("matrix verification actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const requested = {
    completed: false,
    hasSas: false,
    id: "verification-1",
    phaseName: "requested",
  };
  const sas = {
    ...requested,
    hasSas: true,
    phaseName: "started",
    sas: { decimal: [1, 2, 3] },
  };
  const done = { ...sas, completed: true, phaseName: "done" };

  function mockCompletedSelfVerificationCrypto() {
    return {
      ...exchange(requested, [sas]),
      confirmVerificationSas: returns(done),
    };
  }

  function exchange(request: typeof requested, listed: (typeof requested)[]) {
    return { requestVerification: returns(request), listVerifications: returns(listed) };
  }

  function runSelfVerification(timeoutMs = 500, matched = true) {
    return runMatrixSelfVerification({ confirmSas: vi.fn(async () => matched), timeoutMs });
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

  function mockTrustClient(verification = mockVerifiedOwnerStatus(), published = true) {
    return {
      bootstrapOwnDeviceVerification: vi.fn(),
      getOwnCrossSigningPublicationStatus: returns({ published }),
      getOwnDeviceVerificationStatus: returns(verification),
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

  async function expectFailedVerification(
    crypto: ReturnType<typeof exchange>,
    error: string,
    timeout = 500,
    matched = true,
  ) {
    const cancelVerification = returns(undefined);
    useStartedClient({ crypto: { ...crypto, cancelVerification } });
    await expect(runSelfVerification(timeout, matched)).rejects.toThrow(error);
    expect(cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  }

  it("uses the resolved default Matrix account when accountId is omitted", async () => {
    const matrix = { defaultAccount: "ops", accounts: { ops: { encryption: false } } };
    useStartedClient({ crypto: null });
    await expect(listMatrixVerifications({ cfg: { channels: { matrix } } })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("refreshes own-device keys before resolving authoritative verification status", async () => {
    const prepareForOneOff = returns(undefined);
    const refreshOwnDeviceKeys = returns(undefined);
    const start = returns(undefined);
    const getOwnDeviceVerificationStatus = returns({
      ...mockVerifiedOwnerStatus(),
      serverDeviceKnown: true,
    });
    useResolvedClient({
      prepareForOneOff,
      refreshOwnDeviceKeys,
      crypto: {
        listVerifications: returns([]),
        getRecoveryKey: returns({ encodedPrivateKey: "rec-key" }),
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
    expect(withResolvedActionClientMock.mock.calls[0]?.[0]).toMatchObject({ readiness: "none" });
    expect(prepareForOneOff).toHaveBeenCalledTimes(1);
    expect(refreshOwnDeviceKeys).toHaveBeenCalledTimes(1);
    const finalStatusReadOrder = getOwnDeviceVerificationStatus.mock.invocationCallOrder[1];
    if (finalStatusReadOrder === undefined) {
      throw new Error("expected a final Matrix verification status read");
    }
    expect(refreshOwnDeviceKeys.mock.invocationCallOrder[0]).toBeLessThan(finalStatusReadOrder);
    expectUnused(start, withStartedActionClientMock);
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("fails closed before local Matrix prep when the current device is gone", async () => {
    const prepareForOneOff = returns(undefined);
    const getOwnDeviceVerificationStatus = returns({
      ...mockVerifiedOwnerStatus(false),
      serverDeviceKnown: false,
    });
    useResolvedClient({
      crypto: {
        listVerifications: returns([]),
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
    expect(withResolvedActionClientMock.mock.calls[0]?.[0]).toMatchObject({ readiness: "none" });
    expect(prepareForOneOff).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("resolves encryption and backup status without starting the Matrix client", async () => {
    useResolvedClient({
      crypto: {
        getRecoveryKey: returns({ encodedPrivateKey: "rec-key" }),
        listVerifications: returns([{ id: "req-1" }]),
      },
    });
    const encryption = await getMatrixEncryptionStatus({ includeRecoveryKey: true });
    useResolvedClient({ getRoomKeyBackupStatus: returns({ serverVersion: "11", trusted: true }) });
    const backup = await getMatrixRoomKeyBackupStatus();
    expect(encryption).toMatchObject({
      encryptionEnabled: true,
      recoveryKeyStored: true,
      recoveryKey: "rec-key",
      pendingVerifications: 1,
    });
    expect(backup).toMatchObject({ serverVersion: "11", trusted: true });
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("restores room-key backup without startup crypto auto-repair", async () => {
    const restoreRoomKeyBackup = returns({ success: true, imported: 1, total: 1 });
    useResolvedClient({ restoreRoomKeyBackup });
    await restoreMatrixRoomKeyBackup({ recoveryKey: " key " });
    expect(restoreRoomKeyBackup).toHaveBeenCalledWith({ recoveryKey: "key" });
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("rehydrates DM verification requests before follow-up actions", async () => {
    const tracked = { ...requested, transactionId: "txn-dm" };
    const started = { ...tracked, chosenMethod: "m.sas.v1", phaseName: "started" };
    const crypto = {
      ensureVerificationDmTracked: returns(tracked),
      startVerification: returns(started),
    };
    useStartedClient({ crypto });
    await startMatrixVerification("txn-dm", {
      verificationDmRoomId: "!dm:example.org",
      verificationDmUserId: "@alice:example.org",
    });
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
    expectUnused(crypto.ensureVerificationDmTracked, crypto.startVerification);
  });

  const emojiSas = { ...sas, sas: { emoji: [["🐶", "Dog"]] } };
  it.each([
    {
      name: "starts ready SAS and waits for completion",
      request: requested,
      pages: [
        [{ ...requested, phaseName: "ready" }],
        [{ ...emojiSas, completed: true, phaseName: "done" }],
      ],
      start: emojiSas,
      confirmed: emojiSas,
    },
    {
      name: "waits for SAS without restarting",
      request: requested,
      pages: [[{ ...requested, phaseName: "started" }], [sas]],
      start: undefined,
      confirmed: done,
    },
    {
      name: "finalizes completed non-SAS verification",
      request: { ...requested, completed: true, phaseName: "done" },
      pages: [],
      start: undefined,
      confirmed: undefined,
    },
  ])("$name in one client session", async ({ request, pages, start, confirmed }) => {
    const listVerifications = vi.fn();
    for (const page of pages) {
      listVerifications.mockResolvedValueOnce(page);
    }
    const crypto = {
      ...exchange(request, []),
      listVerifications,
      startVerification: start ? returns(start) : vi.fn(),
      confirmVerificationSas: confirmed ? returns(confirmed) : vi.fn(),
    };
    const confirmSas = returns(true);
    const trust = mockTrustClient();
    useStartedClient({ ...trust, crypto });
    expectVerified(await runMatrixSelfVerification({ confirmSas, timeoutMs: 500 }), true);
    expect(withStartedActionClientMock).toHaveBeenCalledTimes(1);
    expectUnused(trust.bootstrapOwnDeviceVerification);
    if (!start) {
      expectUnused(crypto.startVerification);
    }
    if (!confirmed) {
      expectUnused(listVerifications, crypto.confirmVerificationSas, confirmSas);
    } else {
      expect(confirmSas).toHaveBeenCalledWith((start ?? sas).sas, start ?? sas);
    }
    if (start) {
      expect(crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
    }
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
        .mockResolvedValueOnce({ published })
        .mockResolvedValueOnce({ published: true });
      const trustOwnIdentityAfterSelfVerification = returns(undefined);
      useStartedClient({ ...trust, crypto, trustOwnIdentityAfterSelfVerification });

      expectVerified(await runSelfVerification());

      expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(trustCalls);
    },
  );

  it("fails immediately when an already-started self-verification uses a non-SAS method", async () => {
    const started = { ...requested, chosenMethod: "m.reciprocate.v1", phaseName: "started" };
    const crypto = {
      ...exchange(requested, [started]),
      startVerification: vi.fn(),
    };
    await expectFailedVerification(
      crypto,
      "Matrix self-verification started without SAS while waiting to show SAS emoji or decimals (method: m.reciprocate.v1)",
    );
    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("fails self-verification if SAS completes but full identity trust cannot be established", async () => {
    const crypto = { ...mockCompletedSelfVerificationCrypto(), cancelVerification: vi.fn() };
    const trust = mockTrustClient(mockVerifiedOwnerStatus(false), false);
    useStartedClient({
      ...trust,
      crypto,
      trustOwnIdentityAfterSelfVerification: returns(undefined),
    });
    await expect(runSelfVerification(30)).rejects.toThrow(
      "Timed out waiting for Matrix self-verification to establish full Matrix identity trust",
    );
    expectUnused(crypto.cancelVerification, trust.bootstrapOwnDeviceVerification);
  });

  it("cancels the pending self-verification request when acceptance times out", async () => {
    await expectFailedVerification(
      exchange(requested, []),
      "Timed out waiting for Matrix self-verification to be accepted",
      30,
    );
  });

  it("fails immediately when the self-verification request is cancelled while waiting", async () => {
    const cancelled = {
      ...requested,
      error: "Remote cancelled",
      pending: false,
      phaseName: "cancelled",
    };
    const crypto = exchange(requested, [cancelled]);
    await expectFailedVerification(
      crypto,
      "Matrix self-verification was cancelled: Remote cancelled",
    );
    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
  });

  it("cancels the request when SAS mismatch submission fails", async () => {
    const crypto = {
      ...exchange(sas, [sas]),
      mismatchVerificationSas: vi.fn(async () => {
        throw new Error("failed to send SAS mismatch");
      }),
    };
    await expectFailedVerification(crypto, "failed to send SAS mismatch", 500, false);
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
        confirmVerificationSas: returns({
          id,
          isSelfVerification,
          completed,
          error,
        }),
      };
      const trustOwnIdentityAfterSelfVerification = returns(undefined);
      useStartedClient({ crypto, trustOwnIdentityAfterSelfVerification });
      expect(await confirmMatrixVerificationSas(id)).toMatchObject({ isSelfVerification, error });
      expect(crypto.confirmVerificationSas).toHaveBeenCalledWith(id);
      expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(trustCalls);
    },
  );
});
