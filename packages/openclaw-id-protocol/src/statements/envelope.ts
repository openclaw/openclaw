// Building, signing and signature-checking of the statement envelope.
import { base64urlToBytes, bytesToBase64url, concatBytes, utf8, type Bytes } from "../bytes.js";
import { verifyEd25519, type StatementSigner } from "../crypto.js";
import { canonicalize, type JsonValue } from "../jcs.js";
import { formatEd25519PublicKey, rawPublicKey } from "../keys.js";
import type { SignedStatement, StatementBodies, StatementType } from "./types.js";

/** Domain-separation prefix: `openclaw/<type>/v1\0`. */
export function statementDomain(type: StatementType): string {
  return `openclaw/${type}/v1\0`;
}

/** Signing input: UTF-8(domain) || UTF-8(JCS(body)). A signature on one type never verifies as another. */
export function signingInput<T extends StatementType>(type: T, body: StatementBodies[T]): Bytes {
  return concatBytes(utf8(statementDomain(type)), utf8(canonicalize(body as unknown as JsonValue)));
}

/** Signs a statement body. `chain` is the signer's certificate chain (empty when R signs). */
export async function signStatement<T extends StatementType>(
  type: T,
  body: StatementBodies[T],
  signer: StatementSigner,
  chain: SignedStatement<"OwnerDeviceCert">[] = [],
): Promise<SignedStatement<T>> {
  const sig = await signer.sign(signingInput(type, body));
  const statement = {
    v: 1,
    type,
    body,
    signer: formatEd25519PublicKey(signer.publicKey),
    chain,
    alg: "ed25519",
    sig: bytesToBase64url(sig),
  };
  return statement as SignedStatement<T>;
}

/**
 * The chain a device passes when it signs: its own certificate (flattened) followed by
 * that certificate's chain. Signatures do not cover `chain`, so flattening is safe.
 */
export function certificateChain(
  cert: SignedStatement<"OwnerDeviceCert">,
): SignedStatement<"OwnerDeviceCert">[] {
  return [{ ...cert, chain: [] }, ...cert.chain];
}

/** Checks only the envelope signature against `signer`. Authority is checked by verify.ts. */
export async function hasValidSignature(statement: SignedStatement): Promise<boolean> {
  let sig: Bytes;
  try {
    sig = base64urlToBytes(statement.sig);
  } catch {
    return false;
  }
  return verifyEd25519(
    rawPublicKey(statement.signer),
    signingInput(statement.type, statement.body as StatementBodies[typeof statement.type]),
    sig,
  );
}
