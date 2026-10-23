import {
  VerificationPhase,
  VerificationRequestEvent,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMatrixCryptoFacade } from "./crypto-facade.js";
import {
  createMatrixCryptoApi,
  MockVerificationRequest,
  MockVerifier,
} from "./crypto.test-support.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { MatrixVerificationManager } from "./verification-manager.js";

function createSasVerifierFixture(verifyImpl: () => Promise<void> = async () => {}) {
  const confirm = vi.fn(async () => {});
  const mismatch = vi.fn();
  const cancel = vi.fn();
  const verify = vi.fn(verifyImpl);
  return {
    confirm,
    mismatch,
    verify,
    verifier: new MockVerifier(
      {
        sas: {
          decimal: [111, 222, 333],
          emoji: [
            ["cat", "Cat"],
            ["dog", "Dog"],
            ["fox", "Fox"],
          ],
        },
        confirm,
        mismatch,
        cancel,
      },
      null,
      verify,
    ),
  };
}

function trackReadySas(manager: MatrixVerificationManager, isSelfVerification: boolean) {
  const fixture = createSasVerifierFixture();
  const request = new MockVerificationRequest({
    transactionId: "txn-ready",
    isSelfVerification,
  });
  request.startVerification = vi.fn(async (_method: string) => {
    request.phase = VerificationPhase.Started;
    request.verifier = fixture.verifier;
    return fixture.verifier;
  });
  const tracked = manager.trackVerificationRequest(request);
  request.phase = VerificationPhase.Ready;
  request.emit(VerificationRequestEvent.Change);
  return { ...fixture, request, tracked };
}

describe("MatrixVerificationManager", () => {
  let manager: MatrixVerificationManager;
  let trustOwnDeviceAfterSas: Mock<(deviceId: string) => Promise<void>>;
  beforeEach(() => {
    trustOwnDeviceAfterSas = vi.fn(async () => {});
    manager = new MatrixVerificationManager({ trustOwnDeviceAfterSas });
  });
  afterEach(() => vi.useRealTimers());

  function trackSas(
    requestOptions: Partial<MockVerificationRequest> = {},
    verifyImpl?: () => Promise<void>,
  ) {
    const fixture = createSasVerifierFixture(verifyImpl);
    const request = new MockVerificationRequest({
      transactionId: "txn-sas",
      otherDeviceId: "OTHERDEVICE",
      ...requestOptions,
      verifier: fixture.verifier,
    });
    return { ...fixture, request, tracked: manager.trackVerificationRequest(request) };
  }
  function trackPair(
    firstOptions: Partial<MockVerificationRequest>,
    secondOptions: Partial<MockVerificationRequest>,
  ) {
    const first = new MockVerificationRequest(firstOptions);
    const second = new MockVerificationRequest({ ...firstOptions, ...secondOptions });
    return {
      first,
      second,
      firstSummary: manager.trackVerificationRequest(first),
      secondSummary: manager.trackVerificationRequest(second),
    };
  }
  function facadeFor(crypto = createMatrixCryptoApi()) {
    const recoveryKeyStore = new MatrixRecoveryKeyStore();
    const facade = createMatrixCryptoFacade({
      client: { getCrypto: () => crypto, getUserId: () => "@bot:example.org" },
      verificationManager: manager,
      recoveryKeyStore,
      isRoomEncrypted: async () => false,
      downloadContent: async () => Buffer.alloc(0),
    });
    return { facade, recoveryKeyStore };
  }
  it("handles rust verification requests whose methods getter throws", () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-rust-methods",
      phase: VerificationPhase.Requested,
      initiatedByMe: true,
    });
    Object.defineProperty(request, "methods", {
      get() {
        throw new Error("not implemented");
      },
    });

    const summary = manager.trackVerificationRequest(request);

    expect(summary.id).toMatch(/^verification-\d+$/u);
    expect(summary.methods).toStrictEqual([]);
    expect(summary.phaseName).toBe("requested");
  });

  it("reuses the tracked id when the other device id is populated later", () => {
    const { firstSummary, secondSummary } = trackPair(
      { transactionId: "txn-device-later", phase: VerificationPhase.Requested },
      {
        phase: VerificationPhase.Ready,
        otherDeviceId: "DEVICE_LATER",
        pending: false,
        chosenMethod: "m.sas.v1",
      },
    );

    expect(secondSummary).toMatchObject({
      id: firstSummary.id,
      otherDeviceId: "DEVICE_LATER",
      phase: VerificationPhase.Ready,
      pending: false,
      chosenMethod: "m.sas.v1",
    });
    expect(manager.listVerifications()).toHaveLength(1);
  });

  it("keeps separate sessions when stable other device ids differ", () => {
    const { firstSummary, secondSummary } = trackPair(
      { transactionId: "txn-different-devices", otherDeviceId: "DEVICE_A" },
      { otherDeviceId: "DEVICE_B" },
    );

    expect(secondSummary.id).not.toBe(firstSummary.id);
    expect(manager.listVerifications()).toHaveLength(2);
  });

  it("does not overwrite a different verification request with a colliding transaction ID", async () => {
    const { first, second, firstSummary, secondSummary } = trackPair(
      {
        transactionId: "txn-collision",
        initiatedByMe: true,
        otherUserId: "@alice:example.org",
        otherDeviceId: "ALICE1",
      },
      { otherUserId: "@mallory:example.org", otherDeviceId: "MALLORY1" },
    );

    expect(secondSummary.id).not.toBe(firstSummary.id);
    expect(manager.listVerifications()).toHaveLength(2);
    expect(() => manager.getVerificationSas("txn-collision")).toThrow(
      "Matrix verification request id is ambiguous for transaction txn-collision",
    );
    await manager.acceptVerification(firstSummary.id);
    expect(first.accept).toHaveBeenCalledTimes(1);
    expect(second.accept).not.toHaveBeenCalled();
  });

  it("starts SAS verification and exposes SAS payload/callback flow", async () => {
    const { confirm, mismatch, tracked } = trackSas();

    const started = await manager.startVerification(tracked.id, "sas");
    expect(started).toMatchObject({ hasSas: true, sas: { decimal: [111, 222, 333] } });
    expect(started.sas?.emoji?.length).toBe(3);

    const sas = manager.getVerificationSas(tracked.id);
    expect(sas.decimal).toEqual([111, 222, 333]);
    expect(sas.emoji?.length).toBe(3);

    await manager.confirmVerificationSas(tracked.id);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(trustOwnDeviceAfterSas).not.toHaveBeenCalled();

    manager.mismatchVerificationSas(tracked.id);
    expect(mismatch).toHaveBeenCalledTimes(1);
  });

  it("emits summary updates when SAS becomes available", async () => {
    const { verifier, verify } = createSasVerifierFixture();
    const request = new MockVerificationRequest({
      transactionId: "txn-summary-listener",
      roomId: "!dm:example.org",
      verifier: undefined,
    });
    const summaries: ReturnType<MatrixVerificationManager["listVerifications"]> = [];
    manager = new MatrixVerificationManager({
      onSummaryChanged: (summary) => summaries.push(summary),
    });

    manager.trackVerificationRequest(request);
    request.verifier = verifier;
    request.emit(VerificationRequestEvent.Change);

    await vi.waitFor(() => {
      expect(summaries).toContainEqual(
        expect.objectContaining({
          transactionId: "txn-summary-listener",
          roomId: "!dm:example.org",
          hasSas: true,
        }),
      );
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it("does not auto-start non-self inbound SAS when request becomes ready without a verifier", async () => {
    const { verify, request, tracked } = trackReadySas(manager, false);

    await vi.waitFor(() => {
      expect(manager.listVerifications().find((item) => item.id === tracked.id)?.phase).toBe(
        VerificationPhase.Ready,
      );
    });
    expect(request.startVerification).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(manager.listVerifications().find((item) => item.id === tracked.id)?.hasSas).toBe(false);
  });

  it("auto-starts self verification SAS when request becomes ready without a verifier", async () => {
    const { verify, request, tracked } = trackReadySas(manager, true);

    await vi.waitFor(() => {
      expect(request.startVerification).toHaveBeenCalledWith("m.sas.v1");
    });
    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
    expect(manager.listVerifications().find((item) => item.id === tracked.id)).toMatchObject({
      hasSas: true,
      sas: { decimal: [111, 222, 333] },
    });
    expect(manager.getVerificationSas(tracked.id).decimal).toEqual([111, 222, 333]);
  });

  it("auto-accepts incoming verification requests only once per transaction", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-auto-accept-once",
    });

    manager.trackVerificationRequest(request);
    request.emit(VerificationRequestEvent.Change);
    manager.trackVerificationRequest(request);

    await vi.waitFor(() => {
      expect(request.accept).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["inbound self-verification", true, false, false, 1],
    ["locally initiated verification", false, true, false, 0],
    ["explicitly mismatched verification", false, false, true, 0],
  ] as const)(
    "delays or cancels auto-confirm for %s",
    async (_name, isSelfVerification, initiatedByMe, reject, calls) => {
      vi.useFakeTimers();
      const { confirm, mismatch, tracked } = trackSas({ isSelfVerification, initiatedByMe });
      if (reject) {
        manager.mismatchVerificationSas(tracked.id);
        expect(mismatch).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(29_000);
      expect(confirm).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(confirm).toHaveBeenCalledTimes(calls);
      if (calls) {
        expect(trustOwnDeviceAfterSas).toHaveBeenCalledWith("OTHERDEVICE");
      } else {
        expect(trustOwnDeviceAfterSas).not.toHaveBeenCalled();
      }
    },
  );

  it("confirmVerificationSas awaits the verifier's verify promise before resolving", async () => {
    const { promise: verifyPromise, resolve: resolveVerify } = Promise.withResolvers<void>();
    const verifyImpl = vi.fn(() => verifyPromise);
    const { confirm, tracked } = trackSas(
      { isSelfVerification: true, initiatedByMe: true },
      verifyImpl,
    );

    await manager.startVerification(tracked.id, "sas");
    expect(verifyImpl).toHaveBeenCalledTimes(1);

    let confirmResolved = false;
    const confirmPromise = manager.confirmVerificationSas(tracked.id).then(() => {
      confirmResolved = true;
    });

    // Finish confirmation and trust while the protocol completion remains pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(trustOwnDeviceAfterSas).toHaveBeenCalledWith("OTHERDEVICE");
    expect(confirmResolved).toBe(false);

    resolveVerify();
    await confirmPromise;
    expect(confirmResolved).toBe(true);
  });

  it("confirmVerificationSas surfaces a verifier-promise rejection on session.error", async () => {
    const verifyImpl = vi.fn(async () => {
      throw new Error("verifier rejected mid-protocol");
    });
    const { tracked } = trackSas({ isSelfVerification: true, initiatedByMe: true }, verifyImpl);

    await manager.startVerification(tracked.id, "sas");
    const summary = await manager.confirmVerificationSas(tracked.id);

    expect(summary.error).toMatch(/verifier rejected mid-protocol/);
  });

  it("prunes stale terminal sessions during list operations", () => {
    const now = new Date("2026-02-08T15:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(now);

    manager.trackVerificationRequest(
      new MockVerificationRequest({
        transactionId: "txn-old-done",
        phase: VerificationPhase.Done,
        pending: false,
      }),
    );

    nowSpy.mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    expect(manager.listVerifications()).toHaveLength(0);
    nowSpy.mockRestore();
  });

  it("forwards facade verification and recovery-key requests to their owners", async () => {
    const request = new MockVerificationRequest({ initiatedByMe: true });
    const crypto = createMatrixCryptoApi({ requestDeviceVerification: vi.fn(async () => request) });
    const { facade, recoveryKeyStore } = facadeFor(crypto);
    vi.spyOn(recoveryKeyStore, "getRecoveryKeySummary").mockResolvedValue({ keyId: "KEY" });
    const result = await facade.requestVerification({
      userId: "@alice:example.org",
      deviceId: "DEVICE",
    });
    expect(crypto.requestDeviceVerification).toHaveBeenCalledWith("@alice:example.org", "DEVICE");
    expect(result.id).toBe("verification-1");
    await expect(facade.getRecoveryKey()).resolves.toEqual({ keyId: "KEY" });
  });

  it("rehydrates in-progress DM verification from the raw crypto layer", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-dm-in-progress",
      roomId: "!dm:example.org",
      phase: VerificationPhase.Started,
    });
    const crypto = createMatrixCryptoApi({
      findVerificationRequestDMInProgress: vi.fn(() => request),
    });
    const { facade } = facadeFor(crypto);
    const summary = await facade.ensureVerificationDmTracked({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });
    expect(crypto.findVerificationRequestDMInProgress).toHaveBeenCalledWith(
      "!dm:example.org",
      "@alice:example.org",
    );
    expect(summary).toMatchObject({
      transactionId: "txn-dm-in-progress",
      roomId: "!dm:example.org",
      phaseName: "started",
    });
    expect(manager.listVerifications()).toEqual([summary]);
  });

  it("rehydrates in-progress to-device verification before facade listing", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-self-in-progress",
      otherUserId: "@bot:example.org",
      initiatedByMe: true,
      isSelfVerification: true,
      phase: VerificationPhase.Ready,
    });
    const crypto = createMatrixCryptoApi({
      getVerificationRequestsToDeviceInProgress: vi.fn(() => [request]),
    });
    const { facade } = facadeFor(crypto);
    expect(await facade.listVerifications()).toEqual([
      expect.objectContaining({
        transactionId: "txn-self-in-progress",
        otherUserId: "@bot:example.org",
        isSelfVerification: true,
        initiatedByMe: true,
      }),
    ]);
    expect(crypto.getVerificationRequestsToDeviceInProgress).toHaveBeenCalledWith(
      "@bot:example.org",
    );
  });
});
