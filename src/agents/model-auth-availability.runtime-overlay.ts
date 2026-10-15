/** Runtime-snapshot credential overlay for read-only auth availability. */
import { hasNonEmptyString as hasSecret } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef } from "../config/types.secrets.js";
import { hasUsableOAuthCredential } from "./auth-profiles/credential-state.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

export type RuntimeCredentialOverlay = {
  overlay: (profileId: string, credential: AuthProfileCredential) => AuthProfileCredential;
  /** Profiles whose secret value came from the runtime snapshot. */
  hydratedProfileIds: ReadonlySet<string>;
};

/** Overlays prepared runtime secrets onto persisted profiles with the same secret ref. */
export function createRuntimeCredentialOverlay(params: {
  cfg: OpenClawConfig;
  runtimeStore: Pick<AuthProfileStore, "profiles"> | undefined;
  now: number;
}): RuntimeCredentialOverlay {
  const hydratedProfileIds = new Set<string>();
  const overlay = (profileId: string, credential: AuthProfileCredential): AuthProfileCredential => {
    const runtime = params.runtimeStore?.profiles[profileId];
    if (!runtime || credential.type !== runtime.type || credential.provider !== runtime.provider) {
      return credential;
    }
    // The snapshot key plus profile id and provider/type establish runtime ownership.
    // Only ref-only stubs bootstrap; inline persisted OAuth remains authoritative.
    if (
      credential.type === "oauth" &&
      runtime.type === "oauth" &&
      credential.oauthRef &&
      !hasSecret(credential.access) &&
      !hasSecret(credential.refresh) &&
      hasUsableOAuthCredential(runtime, { now: params.now })
    ) {
      return runtime;
    }
    if (credential.type === "oauth" || runtime.type === "oauth") {
      return credential;
    }
    const configuredRef = parseSecretRef(
      credential.type === "api_key"
        ? (credential.keyRef ?? credential.key)
        : (credential.tokenRef ?? credential.token),
      params.cfg.secrets?.defaults,
    );
    const runtimeRef = parseSecretRef(
      runtime.type === "api_key" ? runtime.keyRef : runtime.tokenRef,
      params.cfg.secrets?.defaults,
    );
    const value = runtime.type === "api_key" ? runtime.key : runtime.token;
    if (
      configuredRef === null ||
      runtimeRef === null ||
      configuredRef.source !== runtimeRef.source ||
      configuredRef.provider !== runtimeRef.provider ||
      configuredRef.id !== runtimeRef.id ||
      !hasSecret(value)
    ) {
      return credential;
    }
    hydratedProfileIds.add(profileId);
    return credential.type === "api_key"
      ? { ...credential, key: value }
      : { ...credential, token: value };
  };
  return { overlay, hydratedProfileIds };
}
