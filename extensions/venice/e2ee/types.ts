/** Result of full DCAP quote signature and certificate chain verification. */
export interface DcapVerifyResult {
  /** TCB status: 'UpToDate', 'SWHardeningNeeded', 'OutOfDate', etc. */
  status: string;
  /** Intel security advisory IDs (e.g. 'INTEL-SA-00334') */
  advisoryIds: string[];
}

/**
 * Function that performs full TDX DCAP quote verification.
 * Accepts raw quote bytes and returns verification result.
 * Use `createDcapVerifier()` from `venice-e2ee/dcap` for the default implementation.
 */
export type DcapVerifier = (quoteBytes: Uint8Array) => Promise<DcapVerifyResult>;

export interface VeniceE2EEOptions {
  apiKey: string;
  baseUrl?: string;
  sessionTTL?: number;
  /** Set to false to skip TEE attestation verification. Default: true */
  verifyAttestation?: boolean;
  /**
   * Optional DCAP verifier for full TDX quote signature and cert chain verification.
   * When provided, runs alongside v1 binding checks for complete attestation.
   *
   * ```ts
   * import { createDcapVerifier } from 'venice-e2ee/dcap';
   * const e2ee = createVeniceE2EE({ apiKey, dcapVerifier: createDcapVerifier() });
   * ```
   */
  dcapVerifier?: DcapVerifier;
}

export interface E2EESession {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  pubKeyHex: string;
  modelPubKeyHex: string;
  aesKey: CryptoKey;
  modelId: string;
  created: number;
  /** Attestation verification result (present when verifyAttestation is true) */
  attestation?: import("./attestation.js").AttestationResult;
}

export interface EncryptedPayload {
  encryptedMessages: Array<{ role: string; content: string }>;
  headers: Record<string, string>;
  veniceParameters: { enable_e2ee: true };
}
