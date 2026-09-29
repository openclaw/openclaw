import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { ensureMatrixCryptoRuntime } from "../deps.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { EncryptedFile } from "./types.js";
import type {
  MatrixVerificationCryptoApi,
  MatrixVerificationManager,
} from "./verification-manager.js";

type MatrixCryptoFacadeClient = {
  getCrypto: () => unknown;
  getUserId: () => string | null;
};

type MatrixCryptoNodeRuntime = typeof import("./crypto-node.runtime.js");
const matrixCryptoNodeRuntimeLoader = createLazyRuntimeModule(
  () => import("./crypto-node.runtime.js"),
);

async function loadMatrixCryptoNodeRuntime(): Promise<MatrixCryptoNodeRuntime> {
  // Keep the native crypto package out of the main CLI startup graph.
  try {
    return await matrixCryptoNodeRuntimeLoader();
  } catch (error) {
    matrixCryptoNodeRuntimeLoader.clear();
    throw error;
  }
}

async function loadMatrixCryptoNodeBindings() {
  await ensureMatrixCryptoRuntime();
  const runtime = await loadMatrixCryptoNodeRuntime();
  return runtime.loadMatrixCryptoNodeBindings();
}

export function createMatrixCryptoFacade(deps: {
  client: MatrixCryptoFacadeClient;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
  downloadContent: (
    mxcUrl: string,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
}) {
  const manager = deps.verificationManager;
  function withTrackedVerifications<TArgs extends unknown[], TResult>(
    run: (...args: TArgs) => TResult,
  ) {
    return async (...args: TArgs): Promise<Awaited<TResult>> => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      const userId = deps.client.getUserId();
      if (userId && typeof crypto?.getVerificationRequestsToDeviceInProgress === "function") {
        for (const request of crypto.getVerificationRequestsToDeviceInProgress(userId)) {
          manager.trackVerificationRequest(request);
        }
      }
      return await run(...args);
    };
  }

  return {
    isRoomEncrypted: deps.isRoomEncrypted,
    requestOwnUserVerification: async () => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestOwnUserVerification(crypto);
    },
    encryptMedia: async (
      buffer: Buffer,
    ): Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }> => {
      const { Attachment } = await loadMatrixCryptoNodeBindings();
      const encrypted = Attachment.encrypt(new Uint8Array(buffer));
      const mediaInfoJson = encrypted.mediaEncryptionInfo;
      if (!mediaInfoJson) {
        throw new Error("Matrix media encryption failed: missing media encryption info");
      }
      const parsed = JSON.parse(mediaInfoJson) as EncryptedFile;
      return {
        buffer: Buffer.from(encrypted.encryptedData),
        file: {
          key: parsed.key,
          iv: parsed.iv,
          hashes: parsed.hashes,
          v: parsed.v,
        },
      };
    },
    decryptMedia: async (
      file: EncryptedFile,
      opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
    ): Promise<Buffer> => {
      const encrypted = await deps.downloadContent(file.url, opts);
      const { Attachment, EncryptedAttachment } = await loadMatrixCryptoNodeBindings();
      const metadata: EncryptedFile = {
        url: file.url,
        key: file.key,
        iv: file.iv,
        hashes: file.hashes,
        v: file.v,
      };
      const attachment = new EncryptedAttachment(
        new Uint8Array(encrypted),
        JSON.stringify(metadata),
      );
      const decrypted = Attachment.decrypt(attachment);
      return Buffer.from(decrypted);
    },
    getRecoveryKey: async () => {
      return deps.recoveryKeyStore.getRecoveryKeySummary();
    },
    listVerifications: withTrackedVerifications(manager.listVerifications.bind(manager)),
    ensureVerificationDmTracked: async ({ roomId, userId }: { roomId: string; userId: string }) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      const request =
        typeof crypto?.findVerificationRequestDMInProgress === "function"
          ? crypto.findVerificationRequestDMInProgress(roomId, userId)
          : undefined;
      if (!request) {
        return null;
      }
      return deps.verificationManager.trackVerificationRequest(request);
    },
    requestVerification: async (params: {
      ownUser?: boolean;
      userId?: string;
      deviceId?: string;
      roomId?: string;
    }) => {
      const crypto = deps.client.getCrypto() as MatrixVerificationCryptoApi | undefined;
      return await deps.verificationManager.requestVerification(crypto, params);
    },
    acceptVerification: withTrackedVerifications(manager.acceptVerification.bind(manager)),
    cancelVerification: withTrackedVerifications(manager.cancelVerification.bind(manager)),
    startVerification: withTrackedVerifications(manager.startVerification.bind(manager)),
    generateVerificationQr: withTrackedVerifications(manager.generateVerificationQr.bind(manager)),
    scanVerificationQr: withTrackedVerifications(manager.scanVerificationQr.bind(manager)),
    confirmVerificationSas: withTrackedVerifications(manager.confirmVerificationSas.bind(manager)),
    mismatchVerificationSas: withTrackedVerifications(
      manager.mismatchVerificationSas.bind(manager),
    ),
    confirmVerificationReciprocateQr: withTrackedVerifications(
      manager.confirmVerificationReciprocateQr.bind(manager),
    ),
    getVerificationSas: withTrackedVerifications(manager.getVerificationSas.bind(manager)),
  };
}

export type MatrixCryptoFacade = ReturnType<typeof createMatrixCryptoFacade>;
