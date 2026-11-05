import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProviderRateLimitState } from "../llm/provider-rate-limit.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { resolveConfiguredProviderConfig } from "./embedded-agent-runner/model.configured-overrides.js";
import { normalizeConfiguredProviderModel } from "./embedded-agent-runner/model.registry-resolution.js";
import {
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata,
} from "./embedded-agent-runner/model.static-catalog.js";
import { isFailoverError } from "./failover-error.js";
import { isFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import {
  resolveConfigAwareEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "./model-auth-provider-config.js";
import {
  MODEL_FALLBACK_SKIPPED_CODE,
  type FallbackAttempt,
  type ModelFallbackCandidate,
} from "./model-fallback.types.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

type CandidateRateLimit = { eligible: boolean; retryAt?: number };
type RateLimitSnapshot = ReadonlyMap<ModelFallbackCandidate, CandidateRateLimit>;
type RateLimitContext = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  agentDir?: string;
  sessionId?: string;
  sessionKey?: string;
  userLockedAuthProfileId?: string;
  authStore: AuthProfileStore | null;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
};

/** Orders already admitted candidates from a shared health snapshot without changing policy. */
function orderFallbackCandidatesByRateLimit(
  candidates: ModelFallbackCandidate[],
  snapshot: RateLimitSnapshot,
): { candidates: ModelFallbackCandidate[]; attempts: FallbackAttempt[] } {
  // Preserve configured order among healthy candidates, then wait at the
  // earliest saturated gate only after the available candidates are exhausted.
  const ordered = candidates.toSorted((left, right) => {
    const leftState = snapshot.get(left);
    const rightState = snapshot.get(right);
    const leftRetryAt =
      leftState?.eligible === false ? Infinity : (leftState?.retryAt ?? -Infinity);
    const rightRetryAt =
      rightState?.eligible === false ? Infinity : (rightState?.retryAt ?? -Infinity);
    return leftRetryAt < rightRetryAt ? -1 : leftRetryAt > rightRetryAt ? 1 : 0;
  });
  const selected = ordered[0];
  if (!selected) {
    return { candidates, attempts: [] };
  }
  const index = candidates.indexOf(selected);
  const attempts: FallbackAttempt[] = candidates
    .slice(0, index)
    .filter((candidate) => snapshot.get(candidate)?.retryAt !== undefined)
    .map(({ provider, model }) => ({
      provider,
      model,
      reason: "rate_limit",
      code: MODEL_FALLBACK_SKIPPED_CODE,
      error: `Shared model token rate limit; trying ${selected.provider}/${selected.model} first`,
    }));
  return {
    candidates: ordered,
    attempts,
  };
}

/** Keeps routing and retry eligibility on one read of the canonical account/model owners. */
export function prepareModelFallbackRateLimit(
  candidates: ModelFallbackCandidate[],
  context: RateLimitContext,
) {
  const snapshot: RateLimitSnapshot = new Map(
    candidates.length > 1
      ? candidates.map((candidate) => [
          candidate,
          readFallbackCandidateRateLimit({ ...context, candidate }),
        ])
      : [],
  );
  return {
    ...orderFallbackCandidatesByRateLimit(candidates, snapshot),
    isFinalAttempt(chain: ModelFallbackCandidate[], index: number, excluded: ReadonlySet<string>) {
      return !chain
        .slice(index + 1)
        .some(
          (candidate) =>
            !excluded.has(candidate.provider) && snapshot.get(candidate)?.eligible !== false,
        );
    },
  };
}

/** Reads shared health only from routes and accounts the auth owner can already identify. */
function readFallbackCandidateRateLimit(
  params: RateLimitContext & {
    candidate: ModelFallbackCandidate;
  },
): CandidateRateLimit {
  const { candidate, cfg, authStore } = params;
  try {
    const lookup = { provider: candidate.provider, modelId: candidate.model, cfg };
    const model = normalizeConfiguredProviderModel({
      ...lookup,
      providerConfig: resolveConfiguredProviderConfig(cfg, candidate.provider),
      discoveredModel: resolveBundledStaticCatalogModel(lookup),
      manifestAlias: resolveManifestModelCatalogProviderAliasMetadata(lookup),
    });
    if (!model) {
      return { eligible: true };
    }
    const runtime =
      params.resolveAgentHarnessRuntimeOverride?.(candidate.provider, candidate.model) ??
      resolveAgentHarnessPolicy({
        ...lookup,
        config: cfg,
        modelApi: model.api,
        modelBaseUrl: model.baseUrl,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).runtime;
    // Native harnesses select their own transport/account after admission.
    if (runtime !== "openclaw" && runtime !== "auto") {
      return { eligible: true };
    }
    const prepared = prepareAgentRuntimeAuth({
      provider: candidate.provider,
      modelId: candidate.model,
      modelApi: model.api,
      modelBaseUrl: model.baseUrl,
      config: cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      authProfileStore: authStore ?? { version: 1, profiles: {} },
      sessionAuthProfileId: params.userLockedAuthProfileId,
      sessionAuthProfileSource: params.userLockedAuthProfileId ? "user" : undefined,
      allowTransientCooldownProbe: true,
      harnessId: "openclaw",
    });
    const authScope = params.userLockedAuthProfileId ?? prepared.plan.forwardedAuthProfileId;
    if (
      candidate.routeOrigin !== "requested" &&
      params.sessionId &&
      isFallbackCandidateSkipped({ sessionId: params.sessionId, ...candidate, authScope })
    ) {
      return { eligible: false };
    }
    const attempt = prepared.attempts[0];
    // Recovery accounts do not choose the starting account. If cooldown admission
    // can change that choice, leave it with the auth owner rather than guessing.
    if (
      !attempt ||
      (attempt.kind === "profile" &&
        authStore &&
        isProfileInCooldown(authStore, attempt.profileId, undefined, candidate.model))
    ) {
      return { eligible: true };
    }
    let retryAt = Infinity;
    const profile = attempt.kind === "profile" ? authStore?.profiles[attempt.profileId] : undefined;
    const source = attempt.plan.credentialSource;
    const direct = source?.kind === "direct" ? source.evidence : undefined;
    const apiKeys = profile
      ? [
          profile.type === "api_key"
            ? profile.keyRef
              ? undefined
              : profile.key
            : profile.type === "token"
              ? profile.tokenRef
                ? undefined
                : profile.token
              : undefined,
        ]
      : direct === "provider-config" || direct === "environment"
        ? [
            resolveUsableCustomProviderApiKey({ cfg, provider: candidate.provider })?.apiKey,
            ...(direct === "environment"
              ? [resolveConfigAwareEnvApiKey(cfg, candidate.provider)?.apiKey]
              : []),
          ].filter((key): key is string => Boolean(key))
        : [];
    const route = attempt.plan.modelRoute;
    // Read every possible direct material rather than guessing credential
    // precedence. Unknown material remains with normal request admission.
    for (const apiKey of apiKeys.length ? apiKeys : [undefined]) {
      const state = getProviderRateLimitState(
        route ? { ...model, baseUrl: route.baseUrl } : model,
        { apiKey: apiKey && !isNonSecretApiKeyMarker(apiKey) ? apiKey : undefined },
      );
      if (!state) {
        return { eligible: true };
      }
      retryAt = Math.min(retryAt, state.retryAt);
    }
    return { eligible: true, ...(Number.isFinite(retryAt) ? { retryAt } : {}) };
  } catch (error) {
    // The existing cooldown/auth owner can establish unavailability. Deferred
    // metadata and native credentials still enter normal candidate admission.
    return { eligible: !isFailoverError(error) };
  }
}
