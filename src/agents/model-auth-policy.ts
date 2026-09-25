import type {
  ProviderModelAuthPolicy,
  ProviderModelAuthPolicyContext,
} from "../plugin-sdk/provider-model-types.js";
import { resolveProviderModelPolicySurface } from "../plugins/provider-model-routes.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";

/** Credential renewal and inference authorization are independent provider contracts. */
export function resolveProviderModelAuthPolicy(
  context: ProviderModelAuthPolicyContext,
): ProviderModelAuthPolicy {
  return (
    resolveProviderModelPolicySurface(context.provider)?.resolveModelAuthPolicy?.(context) ?? {
      authRequirement: resolveProviderModelRouteAuthRequirement(context.mode) ?? null,
      compatible: true,
    }
  );
}

type ModelAuthPolicyParams = {
  provider: string;
  modelApi?: string;
  modelBaseUrl?: string;
  mode?: string;
  authFlow?: string;
};

function policyForModel(params: ModelAuthPolicyParams): ProviderModelAuthPolicy {
  return resolveProviderModelAuthPolicy({
    provider: params.provider,
    mode: params.mode,
    authFlow: params.authFlow,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
  });
}

export function isAuthModeAllowedForModel(params: ModelAuthPolicyParams): boolean {
  return policyForModel(params).compatible;
}

export function assertAuthModeAllowedForModel(
  params: ModelAuthPolicyParams & { profileId: string },
): void {
  const policy = policyForModel(params);
  if (policy.compatible) {
    return;
  }
  throw new Error(
    `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} ${policy.incompatibilityReason ?? "does not accept this credential"}.`,
  );
}
