/** Route-aware auth checks for model-picker callers. */
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
  type ModelAuthAvailabilityResolver,
} from "./model-auth-availability.js";
import { createRuntimeProviderAuthLookup } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

export type ProviderModelAuthChecker = ((
  provider: string,
  ref: ModelAuthAvailabilityRef,
) => Promise<boolean>) & {
  evaluateModelAuth(
    provider: string,
    ref: ModelAuthAvailabilityRef,
  ): Promise<ModelAuthAvailabilityEvaluation>;
};

/** Creates a cached provider-auth evaluator bound to one agent/runtime context. */
export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelAuthChecker {
  const authCache = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
  let modelAuthResolver: ModelAuthAvailabilityResolver | undefined;
  const resolveModelAuthResolver = () => {
    if (modelAuthResolver) {
      return modelAuthResolver;
    }
    const authStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const runtimeAuthLookup = createRuntimeProviderAuthLookup({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includePluginSyntheticAuth: true,
    });
    modelAuthResolver = createModelAuthAvailabilityResolver({
      cfg: params.cfg ?? {},
      agentId: params.agentId,
      authStore,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      syntheticAuthProviderRefs: runtimeAuthLookup.syntheticAuthProviderRefs,
      externalCliProviderIds: ["openai"],
    });
    return modelAuthResolver;
  };
  const evaluateModelAuth = (
    provider: string,
    ref: ModelAuthAvailabilityRef,
  ): Promise<ModelAuthAvailabilityEvaluation> => {
    const key = normalizeProviderId(provider);
    const cacheKey = `${key}\0${hashRuntimeConfigValue(ref as unknown as OpenClawConfig)}`;
    return getOrCreatePromise(
      authCache,
      cacheKey,
      () => Promise.resolve().then(() => resolveModelAuthResolver().evaluateModelAuth(key, ref)),
      { cacheRejections: false },
    );
  };
  return Object.assign(
    async (provider: string, ref: ModelAuthAvailabilityRef) =>
      (await evaluateModelAuth(provider, ref)).availability === true,
    { evaluateModelAuth },
  );
}
