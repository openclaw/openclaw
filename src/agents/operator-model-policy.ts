import { parseOperatorModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredAgentId, resolveAmbientOwnerAgentId } from "./agent-scope-config.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeProviderId } from "./model-ref-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

export type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

const modelPolicyMembership = new WeakMap<PreparedOperatorModelPolicy, string>();

/** Comparison uses the original predicate, including models outside concrete discovery choices. */
export function readOperatorModelPolicyMembership(
  policy: PreparedOperatorModelPolicy | undefined,
): string | undefined {
  return policy ? modelPolicyMembership.get(policy) : "unrestricted";
}

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
  const automatic = new Set(prepareAgentModels(params).models.map(identity));
  return params.policy.models.find((ref) => automatic.has(identity(ref)) || params.allows(ref));
}

function identity(ref: ModelRef): string {
  return JSON.stringify([normalizeProviderId(ref.provider), ref.model]);
}

function prepareAgentModels(
  params: { cfg: OpenClawConfig; agentId?: string } & ModelManifestNormalizationContext,
) {
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
  return { models, resolve };
}

function prepareRefs(refs: readonly string[], resolve: (raw: string) => ModelRef | undefined) {
  const exact = new Map<string, ModelRef>();
  const wildcards = new Set<string>();
  for (const raw of refs) {
    const wildcard = parseOperatorModelPolicyWildcardRef(raw);
    if (wildcard) {
      wildcards.add(wildcard.key);
    } else {
      const ref = resolve(raw);
      if (ref) {
        exact.set(identity(ref), ref);
      }
    }
  }
  return {
    exact,
    wildcards: [...wildcards].toSorted(),
    patterns: compileGlobPatterns({ raw: [...wildcards], normalize: (raw) => raw }),
  };
}

function matches(prepared: ReturnType<typeof prepareRefs>, ref: ModelRef) {
  return (
    prepared.exact.has(identity(ref)) ||
    matchesAnyGlobPattern(`${normalizeProviderId(ref.provider)}/${ref.model}`, prepared.patterns)
  );
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
  const agentId = resolveConfiguredAgentId(
    cfg,
    resolveAmbientOwnerAgentId(cfg, policy.sourceAgent),
  );
  const { models: sourceModels, resolve } = prepareAgentModels({
    cfg,
    agentId,
    manifestPlugins: params.manifestPlugins,
  });
  const allowed =
    policy.allow === undefined
      ? {
          exact: new Map(sourceModels.map((ref) => [identity(ref), ref])),
          wildcards: [],
          patterns: [],
        }
      : prepareRefs(policy.allow, resolve);
  const denied = prepareRefs(policy.deny ?? [], resolve);
  const allows = (ref: ModelRef) => matches(allowed, ref) && !matches(denied, ref);
  const models = [
    ...new Map(
      [...sourceModels, ...allowed.exact.values()].map((ref) => [identity(ref), ref]),
    ).values(),
  ]
    .filter(allows)
    .map((ref) => Object.freeze({ ...ref }));
  const prepared = Object.freeze({
    models: Object.freeze(models),
    allows,
  });
  modelPolicyMembership.set(
    prepared,
    JSON.stringify([
      [...allowed.exact.keys()].toSorted(),
      allowed.wildcards,
      [...denied.exact.keys()].toSorted(),
      denied.wildcards,
    ]),
  );
  return prepared;
}
