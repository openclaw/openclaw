import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks as MatrixShowSasCallbacks,
  type ShowQrCodeCallbacks as MatrixShowQrCodeCallbacks,
  type VerificationRequest,
  type VerificationRequestEventHandlerMap,
  type Verifier,
  type VerifierEventHandlerMap,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { TypedEventEmitter } from "matrix-js-sdk/lib/models/typed-event-emitter.js";
import { vi } from "vitest";
import type { MatrixCryptoBootstrapApi } from "./types.js";

export class MockVerifier
  extends TypedEventEmitter<VerifierEvent, VerifierEventHandlerMap>
  implements Verifier
{
  hasBeenCancelled = false;
  userId = "@alice:example.org";
  constructor(
    private readonly sasCallbacks: MatrixShowSasCallbacks | null,
    private readonly qrCallbacks: MatrixShowQrCodeCallbacks | null,
    private readonly verifyImpl: () => Promise<void> = async () => {},
  ) {
    super();
  }

  verify(): Promise<void> {
    return this.verifyImpl();
  }

  cancel(_e: Error): void {
    void _e;
  }

  getShowSasCallbacks(): MatrixShowSasCallbacks | null {
    return this.sasCallbacks;
  }

  getReciprocateQrCodeCallbacks(): MatrixShowQrCodeCallbacks | null {
    return this.qrCallbacks;
  }
}

export class MockVerificationRequest
  extends TypedEventEmitter<VerificationRequestEvent, VerificationRequestEventHandlerMap>
  implements VerificationRequest
{
  transactionId: string | undefined;
  roomId: string | undefined;
  initiatedByMe = false;
  otherUserId = "@alice:example.org";
  otherDeviceId: string | undefined;
  isSelfVerification = false;
  phase = VerificationPhase.Requested;
  pending = true;
  accepting = false;
  declining = false;
  methods: string[] = ["m.sas.v1"];
  chosenMethod: string | null = null;
  cancellationCode: string | null = null;
  cancellingUserId: string | undefined;
  timeout: number | null = null;
  verifier: Verifier | undefined;

  constructor(init?: Partial<MockVerificationRequest>) {
    super();
    Object.assign(this, init);
  }

  otherPartySupportsMethod(method: string): boolean {
    return this.methods.includes(method);
  }

  accept = vi.fn(async () => {
    this.phase = VerificationPhase.Ready;
  });

  cancel = vi.fn(async () => {
    this.phase = VerificationPhase.Cancelled;
  });

  startVerification = vi.fn(async (_method: string) => {
    if (!this.verifier) {
      throw new Error("verifier not configured");
    }
    this.phase = VerificationPhase.Started;
    return this.verifier;
  });

  scanQRCode = vi.fn(async (_qrCodeData: Uint8ClampedArray) => {
    if (!this.verifier) {
      throw new Error("verifier not configured");
    }
    this.phase = VerificationPhase.Started;
    return this.verifier;
  });

  generateQRCode = vi.fn(async () => new Uint8ClampedArray([1, 2, 3]));
}

export function createMatrixCryptoApi(
  overrides: Partial<MatrixCryptoBootstrapApi> = {},
): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    requestOwnUserVerification: vi.fn(async () => new MockVerificationRequest()),
    getVerificationRequestsToDeviceInProgress: vi.fn(() => []),
    findVerificationRequestDMInProgress: vi.fn(() => undefined),
    requestDeviceVerification: vi.fn(async () => new MockVerificationRequest()),
    requestVerificationDM: vi.fn(async () => new MockVerificationRequest()),
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({ privateKey: new Uint8Array(32) })),
    getSecretStorageStatus: vi.fn(async () => ({ ready: false, defaultKeyId: null })),
    getDeviceVerificationStatus: vi.fn(async () => null),
    getSessionBackupPrivateKey: vi.fn(async () => null),
    loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
    getActiveSessionBackupVersion: vi.fn(async () => null),
    getKeyBackupInfo: vi.fn(async () => null),
    isKeyBackupTrusted: vi.fn(async () => ({ trusted: false, matchesDecryptionKey: false })),
    checkKeyBackupAndEnable: vi.fn(async () => null),
    restoreKeyBackup: vi.fn(async () => ({ total: 0, imported: 0 })),
    setDeviceVerified: vi.fn(async () => {}),
    crossSignDevice: vi.fn(async () => {}),
    isCrossSigningReady: vi.fn(async () => true),
    userHasCrossSigningKeys: vi.fn(async () => true),
    ...overrides,
  };
}
