// Building, signing and signature-checking of the statement envelope.
import { base64urlToBytes, bytesToBase64url, concatBytes, utf8, type Bytes } from "../bytes.js";
import { verifyEd25519, type StatementSigner } from "../crypto.js";
import { canonicalize, type JsonValue } from "../jcs.js";
import { formatEd25519PublicKey, rawPublicKey } from "../keys.js";
import { STATEMENT_VERSION, type StatementVersion } from "../version.js";
import type { SignedStatement, StatementBodies, StatementType } from "./types.js";

// Version tag in each envelope version's signing domain. A new envelope version gets its own
// tag, so a signature made under one version never verifies under another.
const DOMAIN_TAG: Record<StatementVersion, string> = { 1: "v1" };

/** Domain-separation prefix: `openclaw/<type>/<version tag>\0` (`openclaw/<type>/v1\0` for v1). */
export function statementDomain(
  type: StatementType,
  version: StatementVersion = STATEMENT_VERSION,
): string {
  return `openclaw/${type}/${DOMAIN_TAG[version]}\0`;
}

/**
 * Signing input: UTF-8(domain) || UTF-8(JCS(body)). A signature on one type, or under one
 * envelope version, never verifies as another.
 */
export function signingInput<T extends StatementType>(
  type: T,
  body: StatementBodies[T],
  version: StatementVersion = STATEMENT_VERSION,
): Bytes {
  // Generic indexed access hides the concrete body types; widening to the union of all
  // bodies lets TypeScript check every statement body as JSON data.
  const widened: StatementBodies[StatementType] = body;
  const json: JsonValue = widened;
  return concatBytes(utf8(statementDomain(type, version)), utf8(canonicalize(json)));
}

/** Signs a statement body as R or an owner device. */
export async function signStatement<T extends StatementType>(
  type: T,
  body: StatementBodies[T],
  signer: StatementSigner,
): Promise<SignedStatement<T>> {
  const sig = await signer.sign(signingInput(type, body));
  const statement = {
    v: STATEMENT_VERSION,
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
    signingInput(
      statement.type,
      // SAFETY: a SignedStatement's body always matches its `type`.
      statement.body as StatementBodies[typeof statement.type],
      statement.v,
    ),
    sig,
  );
}
