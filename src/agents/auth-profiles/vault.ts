import {
  getCredential,
  storeCredential,
  type CredentialScope,
  type VaultOptions,
} from "../../security/credential-vault.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

export const AUTH_PROFILE_VAULT_REF_PREFIX = "vault://";

export type AuthProfileSecretField = "key" | "token";

export type ParsedVaultRef = {
  scope: CredentialScope;
  name: string;
};

type ResolveSecretParams = {
  value?: string;
  vaultRef?: string;
  profileId: string;
  field: AuthProfileSecretField;
  requestor: string;
  defaultScope?: CredentialScope;
  vaultOptions?: VaultOptions;
};

function normalizeScope(value?: string): CredentialScope | null {
  if (
    value === "provider" ||
    value === "channel" ||
    value === "integration" ||
    value === "internal"
  ) {
    return value;
  }
  return null;
}

export function buildVaultRef(params: { scope: CredentialScope; name: string }): string {
  return `${AUTH_PROFILE_VAULT_REF_PREFIX}${params.scope}/${encodeURIComponent(params.name)}`;
}

export function parseVaultRef(value?: string | null): ParsedVaultRef | null {
  const raw = normalizeSecretInput(value);
  if (!raw || !raw.startsWith(AUTH_PROFILE_VAULT_REF_PREFIX)) {
    return null;
  }
  const rest = raw.slice(AUTH_PROFILE_VAULT_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const scope = normalizeScope(rest.slice(0, slash));
  if (!scope) {
    return null;
  }
  const encodedName = rest.slice(slash + 1);
  if (!encodedName) {
    return null;
  }
  try {
    const name = decodeURIComponent(encodedName);
    if (!name.trim()) {
      return null;
    }
    return { scope, name };
  } catch {
    return null;
  }
}

export function isVaultRef(value?: string | null): boolean {
  return parseVaultRef(value) !== null;
}

export function buildAuthProfileVaultSecretName(
  profileId: string,
  field: AuthProfileSecretField,
): string {
  const normalizedProfileId = profileId.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `auth-profile-${normalizedProfileId}-${field}`;
}

export function storeAuthProfileSecret(params: {
  profileId: string;
  field: AuthProfileSecretField;
  value: string;
  scope?: CredentialScope;
  vaultOptions?: VaultOptions;
}): { ok: true; vaultRef: string } | { ok: false; error: string } {
  const raw = normalizeSecretInput(params.value);
  if (!raw) {
    return { ok: false, error: "empty secret value" };
  }
  const scope = params.scope ?? "provider";
  const name = buildAuthProfileVaultSecretName(params.profileId, params.field);
  const result = storeCredential(name, raw, scope, params.vaultOptions);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    vaultRef: buildVaultRef({ scope, name }),
  };
}

export function resolveAuthProfileSecret(params: ResolveSecretParams): string | undefined {
  const explicitRef = normalizeSecretInput(params.vaultRef);
  const refCandidate = explicitRef || normalizeSecretInput(params.value);
  const parsedRef = parseVaultRef(refCandidate);
  if (parsedRef) {
    const resolved = getCredential(
      parsedRef.name,
      parsedRef.scope,
      params.requestor,
      params.vaultOptions,
    );
    if (!resolved.ok) {
      return undefined;
    }
    return normalizeSecretInput(resolved.value);
  }
  const plain = normalizeSecretInput(params.value);
  if (!plain) {
    return undefined;
  }
  return plain;
}
