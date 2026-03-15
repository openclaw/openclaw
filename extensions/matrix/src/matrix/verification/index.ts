/**
 * Matrix SAS (Short Authentication String) interactive device verification.
 *
 * Provides automatic handling of the SAS verification flow so that
 * bots using this plugin can be verified by other Matrix users,
 * enabling proper E2E encryption key sharing.
 */

export { SasVerificationHandler, type SasVerificationHandlerParams } from "./sas-handler.js";
export {
  CancelCode,
  VerificationEventType,
  type SasSession,
  type SasSessionState,
  type VerificationAcceptContent,
  type VerificationCancelContent,
  type VerificationContent,
  type VerificationDoneContent,
  type VerificationKeyContent,
  type VerificationMacContent,
  type VerificationRawEvent,
  type VerificationReadyContent,
  type VerificationRelation,
  type VerificationRequestContent,
  type VerificationStartContent,
} from "./types.js";
export {
  buildMacInfoString,
  buildSasInfoString,
  canonicalJson,
  computeCommitment,
  computeMac,
  computeMacHkdfHmacSha256,
  computeMacHkdfHmacSha256V2,
  computeSasDecimals,
  computeSasEmojis,
  computeSharedSecret,
  decodeUnpaddedBase64,
  deriveSasBytes,
  encodeUnpaddedBase64,
  formatSasEmojis,
  generateX25519KeyPair,
  hkdfSha256,
} from "./sas-crypto.js";
