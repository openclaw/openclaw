import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";
import type { ModelAuthAvailabilityRef } from "./model-auth-availability.types.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

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

export function normalizeModelIdForProvider(provider: string, modelId: string): string | undefined {
  const trimmed = splitTrailingAuthProfile(modelId).model;
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  return normalizeProviderIdForAuth(trimmed.slice(0, slash)) === provider
    ? trimmed.slice(slash + 1).trim() || undefined
    : undefined;
}
