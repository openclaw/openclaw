import { createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * @param {{ integrity: string, packageName: string, version: string,
 *   keys: Array<{ keyid: string, key: string }>,
 *   signatures: Array<{ keyid: string, sig: string }> }} params
 */
export function verifyNpmRegistrySignatures(params) {
  if (!params.integrity.startsWith("sha512-")) {
    throw new Error(`npm registry integrity is missing a sha512 digest for ${params.packageName}.`);
  }
  if (params.signatures.length === 0) {
    throw new Error(
      `npm registry returned no signatures for ${params.packageName}@${params.version}.`,
    );
  }

  const payload = `${params.packageName}@${params.version}:${params.integrity}`;
  for (const signature of params.signatures) {
    const key = params.keys.find((candidate) => candidate.keyid === signature.keyid);
    if (!key) {
      continue;
    }
    const publicKey = createPublicKey({
      key: Buffer.from(key.key, "base64"),
      format: "der",
      type: "spki",
    });
    if (
      verifySignature(
        "sha256",
        Buffer.from(payload, "utf8"),
        publicKey,
        Buffer.from(signature.sig, "base64"),
      )
    ) {
      return;
    }
  }

  throw new Error(
    `npm registry signatures did not verify for ${params.packageName}@${params.version}.`,
  );
}
