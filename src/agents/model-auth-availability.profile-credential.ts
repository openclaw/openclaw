/** Snapshot-scoped credential readiness, including owned OAuth refresh paths. */
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";
import { resolveStoredCredentialReadOnlyAvailability } from "./auth-profiles/read-only-availability.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import type {
  ModelAuthAvailability,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.types.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";

export type AuthTarget = ModelAuthAvailabilityRef & {
  authRequirement?: ProviderModelRouteAuthRequirement;
};
export function modeAllowed(
  provider: string,
  target: AuthTarget,
  mode: string | undefined,
  authFlow?: string,
): boolean {
  const policy = resolveProviderModelAuthPolicy({
    provider,
    mode,
    authFlow,
    api: target.api ?? undefined,
    baseUrl: typeof target.baseUrl === "string" ? target.baseUrl : undefined,
  });
  return (
    policy.compatible &&
    (!target.authRequirement || policy.authRequirement === target.authRequirement)
  );
}

export function createProfileCredentialAvailability(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now: number;
  hydratedProfileIds: ReadonlySet<string>;
  externalCliRefreshProfileIds: Iterable<string>;
  canRefreshProviderOAuth?: (provider: string) => boolean;
}) {
  const { env, now } = params;
  // Refresh authority follows exact profiles marked by the external-auth
  // lifecycle. Provider-wide authority could bless an unrelated stale profile.
  const externalCliRefreshProfileIds = new Set(params.externalCliRefreshProfileIds);
  const providerOAuthRefreshCache = new Map<string, boolean>();
  const canRefreshProviderOAuth = (provider: string) => {
    const normalized = normalizeProviderIdForAuth(provider);
    if (!providerOAuthRefreshCache.has(normalized)) {
      providerOAuthRefreshCache.set(
        normalized,
        params.canRefreshProviderOAuth?.(normalized) === true,
      );
    }
    return providerOAuthRefreshCache.get(normalized) === true;
  };
  return (
    provider: string,
    profileId: string,
    credential: AuthProfileCredential,
    target: AuthTarget,
  ): ModelAuthAvailability => {
    if (
      !modeAllowed(
        provider,
        target,
        credential.type,
        credential.type === "oauth" ? credential.authFlow : undefined,
      )
    ) {
      return false;
    }
    if (params.hydratedProfileIds.has(profileId)) {
      return (
        credential.type !== "token" || credential.expires === undefined || credential.expires > now
      );
    }
    return resolveStoredCredentialReadOnlyAvailability({
      credential,
      cfg: params.cfg,
      env,
      now,
      canRefreshOAuth:
        provider === "openai" ||
        externalCliRefreshProfileIds.has(profileId) ||
        canRefreshProviderOAuth(provider),
    });
  };
}
