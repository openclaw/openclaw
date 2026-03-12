import { describe, expect, it, vi } from "vitest";
import { createMatrixCryptoFacade } from "./crypto-facade.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixVerificationManager } from "./verification-manager.js";

describe("createMatrixCryptoFacade", () => {
  it("detects encrypted rooms from cached room state", async () => {
    const facade = createMatrixCryptoFacade({
      client: {
        getRoom: () => ({
          hasEncryptionStateEvent: () => true,
        }),
        getCrypto: () => undefined,
      },
      verificationManager: {
        requestOwnUserVerification: vi.fn(),
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
      } as unknown as MatrixVerificationManager,
      recoveryKeyStore: {
        getRecoveryKeySummary: vi.fn(() => null),
      } as unknown as MatrixRecoveryKeyStore,
      getRoomStateEvent: vi.fn(async () => ({ algorithm: "m.megolm.v1.aes-sha2" })),
      downloadContent: vi.fn(async () => Buffer.alloc(0)),
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
  });

  it("falls back to server room state when room cache has no encryption event", async () => {
    const getRoomStateEvent = vi.fn(async () => ({
      algorithm: "m.megolm.v1.aes-sha2",
    }));
    const facade = createMatrixCryptoFacade({
      client: {
        getRoom: () => ({
          hasEncryptionStateEvent: () => false,
        }),
        getCrypto: () => undefined,
      },
      verificationManager: {
        requestOwnUserVerification: vi.fn(),
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
      } as unknown as MatrixVerificationManager,
      recoveryKeyStore: {
        getRecoveryKeySummary: vi.fn(() => null),
      } as unknown as MatrixRecoveryKeyStore,
      getRoomStateEvent,
      downloadContent: vi.fn(async () => Buffer.alloc(0)),
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
    expect(getRoomStateEvent).toHaveBeenCalledWith("!room:example.org", "m.room.encryption", "");
  });

  it("forwards verification requests and uses client crypto API", async () => {
    const crypto = { requestOwnUserVerification: vi.fn(async () => null) };
    const requestVerification = vi.fn(async () => ({
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
    }));
    const facade = createMatrixCryptoFacade({
      client: {
        getRoom: () => null,
        getCrypto: () => crypto,
      },
      verificationManager: {
        requestOwnUserVerification: vi.fn(async () => null),
        listVerifications: vi.fn(async () => []),
        requestVerification,
        acceptVerification: vi.fn(),
        cancelVerification: vi.fn(),
        startVerification: vi.fn(),
        generateVerificationQr: vi.fn(),
        scanVerificationQr: vi.fn(),
        confirmVerificationSas: vi.fn(),
        mismatchVerificationSas: vi.fn(),
        confirmVerificationReciprocateQr: vi.fn(),
        getVerificationSas: vi.fn(),
      } as unknown as MatrixVerificationManager,
      recoveryKeyStore: {
        getRecoveryKeySummary: vi.fn(() => ({ keyId: "KEY" })),
      } as unknown as MatrixRecoveryKeyStore,
      getRoomStateEvent: vi.fn(async () => ({})),
      downloadContent: vi.fn(async () => Buffer.alloc(0)),
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
    await expect(facade.getRecoveryKey()).resolves.toMatchObject({ keyId: "KEY" });
  });
});
