import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeTrustedJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { resolveConfiguredAgentId, resolveAmbientOwnerAgentId } from "./agent-scope-config.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";
import {
  operatorModelPolicyIdentity,
  matchesOperatorModelPolicy,
  recordPreparedOperatorModelPolicy,
} from "./operator-model-policy-state.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

/** Preserve the already-selected default when allowed, otherwise use the first compatible source choice. */
export function resolveOperatorModelDefault(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    policy: PreparedOperatorModelPolicy | undefined;
    model: ModelRef;
    allows: (ref: ModelRef) => boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | undefined {
  if (!params.policy || params.policy.allows(params.model)) {
    return params.model;
  }
  const automatic = new Set(
    prepareAgentModels(params, preparedConfigModels(params)).models.map(
      operatorModelPolicyIdentity,
    ),
  );
  return params.policy.models.find(
    (ref) => automatic.has(operatorModelPolicyIdentity(ref)) || params.allows(ref),
  );
}

type PreparedAgentModels = {
  models: ModelRef[];
  resolve: (raw: string) => ModelRef | undefined;
};
type ModelPolicy = NonNullable<GatewayOperatorRoleDefinition["modelPolicy"]>;
type PreparedConfigModels = {
  byAgent: Map<string | undefined, PreparedAgentModels>;
  byPolicy: WeakMap<ModelPolicy, PreparedOperatorModelPolicy | undefined>;
};
const modelsByConfig = new WeakMap<
  OpenClawConfig,
  {
    publication: object | undefined;
    byMetadata: WeakMap<object, PreparedConfigModels>;
  }
>();

function preparedConfigModels({
  cfg,
  manifestPlugins,
}: { cfg: OpenClawConfig } & ModelManifestNormalizationContext): PreparedConfigModels | undefined {
  // Owned metadata and published/frozen config identify stable selection facts.
  // Caller-owned manifest arrays and unbound mutable configs remain live inputs.
  if (manifestPlugins && "owners" in manifestPlugins) {
    const current = runtimeConfigPublication.current;
    const publication = current?.config === cfg ? current.revision : undefined;
    if (publication || isDeeplyFrozenPlainData(cfg)) {
      let cached = modelsByConfig.get(cfg);
      if (!cached || cached.publication !== publication) {
        cached = { publication, byMetadata: new WeakMap() };
        modelsByConfig.set(cfg, cached);
      }
      let prepared = cached.byMetadata.get(manifestPlugins);
      if (!prepared) {
        prepared = { byAgent: new Map(), byPolicy: new WeakMap() };
        // Only config-owned role objects share this publication's lifetime.
        for (const { modelPolicy } of Object.values(cfg.gateway?.roles?.definitions ?? {})) {
          if (modelPolicy) {
            prepared.byPolicy.set(modelPolicy, undefined);
          }
        }
        cached.byMetadata.set(manifestPlugins, prepared);
      }
      return prepared;
    }
  }
  return undefined;
}

function prepareAgentModels(
  params: { cfg: OpenClawConfig; agentId?: string } & ModelManifestNormalizationContext,
  cached: PreparedConfigModels | undefined,
): PreparedAgentModels {
  const { agentId } = params;
  const prepared = cached?.byAgent.get(agentId);
  if (prepared) {
    return prepared;
  }
  const normalization = {
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
    allowPluginNormalization: false,
  };
  const primary = resolveDefaultModelForAgent(normalization);
  const selection = { ...normalization, defaultProvider: primary.provider };
  const aliasIndex = buildModelAliasIndex(selection);
  const resolve = (raw: string) =>
    resolveModelRefFromString({ ...selection, raw, aliasIndex })?.ref;
  const models = [primary];
  for (const raw of resolveConfiguredModelFallbacks(params)) {
    const ref = resolve(raw);
    if (ref) {
      models.push(ref);
    }
  }
  const result = { models, resolve };
  cached?.byAgent.set(agentId, result);
  return result;
}

function prepareRefs(refs: readonly string[], resolve: (raw: string) => ModelRef | undefined) {
  const exact = new Map<string, ModelRef>();
  const wildcards = new Set<string>();
  for (const raw of refs) {
    const wildcard = parseModelPolicyWildcardRef(raw);
    if (wildcard) {
      wildcards.add(wildcard.key);
    } else {
      const ref = resolve(raw);
      if (ref) {
        exact.set(operatorModelPolicyIdentity(ref), ref);
      }
    }
  }
  return {
    exact,
    wildcards: [...wildcards].toSorted(),
  };
}

/** Prepare once per current role/config view; row and execution checks consume only these facts. */
export function prepareOperatorModelPolicy(
  params: {
    cfg: OpenClawConfig;
    policy: GatewayOperatorRoleDefinition["modelPolicy"];
  } & ModelManifestNormalizationContext,
): PreparedOperatorModelPolicy | undefined {
  const { cfg, policy } = params;
  if (!policy) {
    return undefined;
  }
  const cached = preparedConfigModels(params);
  const prepared = cached?.byPolicy.get(policy);
  if (prepared) {
    return prepared;
  }
  const agentId = resolveConfiguredAgentId(
    cfg,
    resolveAmbientOwnerAgentId(cfg, policy.sourceAgent),
  );
  const { models: sourceModels, resolve } = prepareAgentModels(
    { cfg, agentId, manifestPlugins: params.manifestPlugins },
    cached,
  );
  const allowed =
    policy.allow === undefined
      ? {
          exact: new Map(sourceModels.map((ref) => [operatorModelPolicyIdentity(ref), ref])),
          wildcards: [],
        }
      : prepareRefs(policy.allow, resolve);
  const denied = prepareRefs(policy.deny ?? [], resolve);
  const allows = (ref: ModelRef) =>
    matchesOperatorModelPolicy(allowed, ref) && !matchesOperatorModelPolicy(denied, ref);
  const models = [
    ...new Map(
      [...sourceModels, ...allowed.exact.values()].map((ref) => [
        operatorModelPolicyIdentity(ref),
        ref,
      ]),
    ).values(),
  ].filter(allows);
  const result = recordPreparedOperatorModelPolicy(
    freezeTrustedJsonSnapshot({
      models,
      allowed: { exact: [...allowed.exact.keys()].toSorted(), wildcards: allowed.wildcards },
      denied: { exact: [...denied.exact.keys()].toSorted(), wildcards: denied.wildcards },
    }),
    allows,
  );
  if (cached?.byPolicy.has(policy)) {
    cached.byPolicy.set(policy, result);
  }
  return result;
}
