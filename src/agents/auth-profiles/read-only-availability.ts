/** Pure, non-resolving credential availability checks shared by status and route selection. */
import { readFileSync } from "node:fs";
import { hasNonEmptyString as hasSecret } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isSecretRef,
  LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX,
  parseSecretRef,
} from "../../config/types.secrets.js";
import { canResolveEnvSecretRefInReadOnlyPath } from "../../plugin-sdk/secret-ref-readonly.internal.js";
import {
  isBuiltInDefaultSecretProviderRef,
  isValidSecretRef,
  SINGLE_VALUE_FILE_REF_ID,
} from "../../secrets/ref-contract.js";
import {
  GCP_VERTEX_CREDENTIALS_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  SECRETREF_ENV_HEADER_MARKER_PREFIX,
} from "../model-auth-markers.js";
import { hasUsableOAuthCredential, resolveTokenExpiryState } from "./credential-state.js";
import { isOAuthRefreshFence } from "./oauth-refresh-marker.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

type ReadOnlyCredentialAvailability = boolean | undefined;

/** Store revisions do not advance when a token or failure window expires. */
export function resolveAuthStoreReadOnlyValidUntil(store: AuthProfileStore, now: number): number {
  return Math.min(
    ...[
      ...Object.values(store.profiles).map((profile) =>
        profile.type === "token" ? profile.expires : undefined,
      ),
      ...Object.values(store.usageStats ?? {}).flatMap((stats) => [
        stats.blockedUntil,
        stats.cooldownUntil,
        stats.disabledUntil,
      ]),
    ].filter((deadline): deadline is number => deadline !== undefined && deadline > now),
  );
}

export function hasMalformedSecretInputSyntax(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX) ||
    trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX) ||
    trimmed.startsWith("$")
  );
}

export function resolveSecretRefReadOnlyAvailability(
  value: unknown,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ReadOnlyCredentialAvailability {
  if (!isSecretRef(value) || !isValidSecretRef(value)) {
    return false;
  }
  if (value.source === "env") {
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg,
        provider: value.provider,
        id: value.id,
      })
    ) {
      return false;
    }
    return hasSecret(env[value.id]) ? true : undefined;
  }
  const source = cfg.secrets?.providers?.[value.provider];
  if (source?.source !== value.source && !isBuiltInDefaultSecretProviderRef(cfg, value)) {
    return false;
  }
  if (
    value.source === "file" &&
    source?.source === "file" &&
    (source.mode === "singleValue") !== (value.id === SINGLE_VALUE_FILE_REF_ID)
  ) {
    return false;
  }
  return undefined;
}

function isGceMetadataEnvironmentSync(env: NodeJS.ProcessEnv): boolean {
  if (hasSecret(env.GCE_METADATA_HOST) || hasSecret(env.GCE_METADATA_IP)) {
    return true;
  }
  try {
    if (readFileSync("/sys/class/dmi/id/product_name", "utf8").trim() === "Google Compute Engine") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  try {
    if (readFileSync("/sys/class/dmi/id/sys_vendor", "utf8").trim() === "Google") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  return false;
}

function resolveSecretInputReadOnlyAvailability(
  value: unknown,
  refValue: unknown,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ReadOnlyCredentialAvailability {
  const ref =
    parseSecretRef(refValue, cfg.secrets?.defaults) ?? parseSecretRef(value, cfg.secrets?.defaults);
  if (ref) {
    return resolveSecretRefReadOnlyAvailability(ref, cfg, env);
  }
  if (!hasSecret(value) || hasMalformedSecretInputSyntax(value)) {
    return false;
  }
  if (
    typeof value === "string" &&
    value.trim() === GCP_VERTEX_CREDENTIALS_MARKER &&
    (hasSecret(env.GOOGLE_CLOUD_PROJECT) || hasSecret(env.GCLOUD_PROJECT)) &&
    hasSecret(env.GOOGLE_CLOUD_LOCATION) &&
    !hasSecret(env.GOOGLE_APPLICATION_CREDENTIALS) &&
    isGceMetadataEnvironmentSync(env)
  ) {
    return true;
  }
  return isKnownEnvApiKeyMarker(value)
    ? hasSecret(env[value.trim()])
    : isNonSecretApiKeyMarker(value)
      ? undefined
      : true;
}

export function resolveStoredCredentialReadOnlyAvailability(params: {
  credential: AuthProfileCredential;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now?: number;
  canRefreshOAuth?: boolean;
}): ReadOnlyCredentialAvailability {
  const { credential, cfg, env } = params;
  const now = params.now ?? Date.now();
  if (credential.type === "api_key") {
    return resolveSecretInputReadOnlyAvailability(credential.key, credential.keyRef, cfg, env);
  }
  if (credential.type === "token") {
    const expiryState = resolveTokenExpiryState(credential.expires, now);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return false;
    }
    return resolveSecretInputReadOnlyAvailability(credential.token, credential.tokenRef, cfg, env);
  }
  if (hasUsableOAuthCredential(credential, { now })) {
    return true;
  }
  if (isOAuthRefreshFence(credential)) {
    return false;
  }
  // Refresh material is runnable only when the caller owns a refresh path.
  // Ref-only OAuth may hydrate from the runtime snapshot, so it stays unknown.
  if (hasSecret(credential.refresh)) {
    return params.canRefreshOAuth ? true : undefined;
  }
  return credential.oauthRef && !hasSecret(credential.access) ? undefined : false;
}
