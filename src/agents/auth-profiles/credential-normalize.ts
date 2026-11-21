import { coerceSecretRef, hasLegacySecretRefExtraFields } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AuthProfileCredential } from "./types.js";

/** Public SDK write ingress retains its legacy input contract and publishes canonical refs. */
export function normalizeAuthProfileSecretRefs(
  credential: AuthProfileCredential,
): AuthProfileCredential {
  if (credential.type !== "api_key" && credential.type !== "token") {
    return credential;
  }
  const value = credential.type === "api_key" ? credential.keyRef : credential.tokenRef;
  if (hasLegacySecretRefExtraFields(value)) {
    throw new Error(
      "Auth profile SecretRef contains unsupported fields. Preserve that metadata separately and explicitly call coerceSecretRef before saving a source/provider/id reference.",
    );
  }
  const ref = coerceSecretRef(value);
  if (!ref || ref === value) {
    return credential;
  }
  return credential.type === "api_key"
    ? { ...credential, keyRef: ref }
    : { ...credential, tokenRef: ref };
}

// Upsert paths normalize literal secret strings but preserve SecretRef-backed
// credentials for the secret resolver.
export function normalizeAuthProfileCredential(
  input: AuthProfileCredential,
): AuthProfileCredential {
  const credential = normalizeAuthProfileSecretRefs(input);
  if (credential.type !== "api_key" && credential.type !== "token") {
    return credential;
  }
  const value = credential.type === "api_key" ? credential.key : credential.token;
  if (typeof value !== "string") {
    return credential;
  }
  const normalized = normalizeSecretInput(value);
  if (credential.type === "api_key") {
    const { key: _key, ...rest } = credential;
    return { ...rest, ...(normalized ? { key: normalized } : {}) };
  }
  const { token: _token, ...rest } = credential;
  return { ...rest, ...(normalized ? { token: normalized } : {}) };
}
