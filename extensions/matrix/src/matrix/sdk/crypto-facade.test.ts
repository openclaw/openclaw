import { describe, expect, it, vi } from "vitest";
import { createMatrixCryptoFacade } from "./crypto-facade.js";
import { createMatrixCryptoApi, MockVerificationRequest } from "./crypto.test-support.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixVerificationManager } from "./verification-manager.js";

type MatrixCryptoFacadeDeps = Parameters<typeof createMatrixCryptoFacade>[0];
type VerificationSummary = ReturnType<MatrixVerificationManager["trackVerificationRequest"]>;

function makeSummary(overrides: Partial<VerificationSummary> = {}): VerificationSummary {
  return {
    id: "verification-1",
    otherUserId: "@alice:example.org",
    isSelfVerification: false,
    initiatedByMe: true,
    phase: 2,
    phaseName: "ready",
    pending: true,
    methods: ["m.sas.v1"],
    canAccept: false,
    hasSas: false,
    hasReciprocateQr: false,
    completed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createVerificationManagerMock(
  overrides: Partial<MatrixVerificationManager> = {},
): MatrixVerificationManager {
  return {
    listVerifications: vi.fn(async () => []),
    requestVerification: vi.fn(),
    acceptVerification: vi.fn(),
    cancelVerification: vi.fn(),
    startVerification: vi.fn(),
    generateVerificationQr: vi.fn(),
    scanVerificationQr: vi.fn(),
    confirmVerificationSas: vi.fn(),
    mismatchVerificationSas: vi.fn(),
    confirmVerificationReciprocateQr: vi.fn(),
    getVerificationSas: vi.fn(),
    ...overrides,
  } as unknown as MatrixVerificationManager;
}

function createFacadeHarness(params?: {
  crypto?: ReturnType<MatrixCryptoFacadeDeps["client"]["getCrypto"]>;
  verificationManager?: Partial<MatrixVerificationManager>;
  recoveryKeySummary?: Awaited<ReturnType<MatrixRecoveryKeyStore["getRecoveryKeySummary"]>>;
}) {
  return createMatrixCryptoFacade({
    client: {
      getCrypto: () => params?.crypto,
      getUserId: () => "@bot:example.org",
    },
    verificationManager: createVerificationManagerMock(params?.verificationManager),
    recoveryKeyStore: {
      getRecoveryKeySummary: vi.fn(async () => params?.recoveryKeySummary ?? null),
    } as unknown as MatrixRecoveryKeyStore,
    downloadContent: async () => Buffer.alloc(0),
  });
}

describe("createMatrixCryptoFacade", () => {
  it("forwards verification requests and uses client crypto API", async () => {
    const crypto = createMatrixCryptoApi();
    const requestVerification = vi.fn(async () => makeSummary());
    const facade = createFacadeHarness({
      crypto,
      verificationManager: {
        requestVerification,
      },
      recoveryKeySummary: { keyId: "KEY" },
    });

    const result = await facade.requestVerification({
      userId: "@alice:example.org",
      deviceId: "DEVICE",
    });

    expect(requestVerification).toHaveBeenCalledWith(crypto, {
      userId: "@alice:example.org",
      deviceId: "DEVICE",
    });
    expect(result.id).toBe("verification-1");
    await expect(facade.getRecoveryKey()).resolves.toEqual({ keyId: "KEY" });
  });

  it("rehydrates in-progress DM verification requests from the raw crypto layer", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-dm-in-progress",
      roomId: "!dm:example.org",
      phase: 3,
    });
    const trackVerificationRequest = vi.fn(() =>
      makeSummary({
        transactionId: "txn-dm-in-progress",
        roomId: "!dm:example.org",
        initiatedByMe: false,
        phase: 3,
        phaseName: "started",
      }),
    );
    const crypto = createMatrixCryptoApi({
      findVerificationRequestDMInProgress: vi.fn(() => request),
    });
    const facade = createFacadeHarness({
      crypto,
      verificationManager: {
        trackVerificationRequest,
      },
    });

    const summary = await facade.ensureVerificationDmTracked({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });

    expect(crypto.findVerificationRequestDMInProgress).toHaveBeenCalledWith(
      "!dm:example.org",
      "@alice:example.org",
    );
    expect(trackVerificationRequest).toHaveBeenCalledWith(request);
    expect(summary?.transactionId).toBe("txn-dm-in-progress");
  });

  it("rehydrates in-progress to-device verification requests before listing", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-self-in-progress",
      otherUserId: "@bot:example.org",
      initiatedByMe: true,
      isSelfVerification: true,
      phase: 2,
    });
    const tracked = makeSummary({
      transactionId: "txn-self-in-progress",
      otherUserId: "@bot:example.org",
      isSelfVerification: true,
      initiatedByMe: true,
    });
    const trackVerificationRequest = vi.fn(() => tracked);
    const listVerifications = vi.fn(() => [tracked]);
    const crypto = createMatrixCryptoApi({
      getVerificationRequestsToDeviceInProgress: vi.fn(() => [request]),
    });
    const facade = createFacadeHarness({
      crypto,
      verificationManager: {
        listVerifications,
        trackVerificationRequest,
      },
    });

    const summaries = await facade.listVerifications();

    expect(crypto.getVerificationRequestsToDeviceInProgress).toHaveBeenCalledWith(
      "@bot:example.org",
    );
    expect(trackVerificationRequest).toHaveBeenCalledWith(request);
    expect(summaries).toEqual([tracked]);
  });
});
