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
  // SAFETY: statement bodies are plain JSON data; canonicalize rejects anything else.
  return concatBytes(utf8(statementDomain(type)), utf8(canonicalize(body as unknown as JsonValue)));
}

/** Signs a statement body as R or an owner device. */
export async function signStatement<T extends StatementType>(
  type: T,
  body: StatementBodies[T],
  signer: StatementSigner,
): Promise<SignedStatement<T>> {
  const sig = await signer.sign(signingInput(type, body));
  const statement = {
    v: 1,
    type,
    body,
    signer: formatEd25519PublicKey(signer.publicKey),
    alg: "ed25519",
    sig: bytesToBase64url(sig),
  };
  // SAFETY: literal fields build the envelope; TypeScript widens `v` and `alg` on the object.
  return statement as SignedStatement<T>;
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
    // SAFETY: a SignedStatement's body always matches its `type`.
    signingInput(statement.type, statement.body as StatementBodies[typeof statement.type]),
    sig,
  );
}
