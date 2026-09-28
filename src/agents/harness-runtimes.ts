/**
 * Collects configured native harness runtime ids from model provider config.
 */
import {
  listModelRefsFromConfigValue,
  type ConfiguredModelRef,
} from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import {
  OPENCLAW_AGENT_RUNTIME_ID,
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "./agent-runtime-id.js";
import { listAgentEntries, withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

// Harness runtime discovery feeds plugin preloading/setup. Only plugin runtimes
// are selectable here; built-in OpenClaw/default runtime ids are excluded.
function isSelectablePluginRuntime(runtime: string | undefined): runtime is string {
  return (
    Boolean(runtime) &&
    !isDefaultAgentRuntimeId(runtime) &&
    normalizeOptionalAgentRuntimeId(runtime) !== OPENCLAW_AGENT_RUNTIME_ID
  );
}

// Parse provider/model identity without interpreting a selector's auth profile.
function parseConfiguredModelRef(
  value: unknown,
): { provider: string; modelId: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parseModelCatalogRef(value) ?? undefined;
}

export function resolveConfiguredModelHarnessRuntime(params: {
  config: OpenClawConfig;
  includeImplicitRuntimePreferences: boolean;
  modelRef: string;
  modelRefKind: ConfiguredModelRef["kind"];
  agentId?: string;
}): string | undefined {
  const parsed = parseConfiguredModelRef(params.modelRef);
  if (!parsed) {
    return undefined;
  }
  const selection =
    params.modelRefKind === "selector" ? splitTrailingAuthProfile(params.modelRef) : undefined;
  const policyModel = selection?.profile ? parseConfiguredModelRef(selection.model) : parsed;
  if (!policyModel) {
    return undefined;
  }
  const policyParams = {
    config: params.config,
    provider: parsed.provider,
    modelId: parsed.modelId,
    agentId: params.agentId,
  };
  // Match preferences on the model while retaining the profile for implicit routing.
  const configured = resolveModelRuntimePolicy({
    ...policyParams,
    modelId: policyModel.modelId,
  });
  const policy = resolveAgentHarnessPolicy(policyParams, configured);
  if (!params.includeImplicitRuntimePreferences && policy.runtimeSource === "implicit") {
    return undefined;
  }
  const runtime = normalizeOptionalAgentRuntimeId(policy.runtime);
  return isSelectablePluginRuntime(runtime) ? runtime : undefined;
}

function pushConfiguredModelRuntimeIds(config: OpenClawConfig, runtimes: Set<string>): void {
  for (const providerConfig of Object.values(config.models?.providers ?? {})) {
    const providerRuntime = normalizeOptionalAgentRuntimeId(providerConfig?.agentRuntime?.id);
    if (isSelectablePluginRuntime(providerRuntime)) {
      runtimes.add(providerRuntime);
    }
    for (const modelConfig of providerConfig?.models ?? []) {
      const modelRuntime = normalizeOptionalAgentRuntimeId(modelConfig?.agentRuntime?.id);
      if (isSelectablePluginRuntime(modelRuntime)) {
        runtimes.add(modelRuntime);
      }
    }
  }
  const pushModelMapRuntimeIds = (models: unknown) => {
    if (!isRecord(models)) {
      return;
    }
    for (const entry of Object.values(models)) {
      if (!isRecord(entry)) {
        continue;
      }
      const runtime = normalizeOptionalAgentRuntimeId(
        isRecord(entry.agentRuntime) ? entry.agentRuntime.id : undefined,
      );
      if (isSelectablePluginRuntime(runtime)) {
        runtimes.add(runtime);
      }
      for (const value of Array.isArray(entry.pickerRuntimes) ? entry.pickerRuntimes : []) {
        const pickerRuntime = normalizeOptionalAgentRuntimeId(value);
        if (isSelectablePluginRuntime(pickerRuntime)) {
          runtimes.add(pickerRuntime);
        }
      }
    }
  };
  pushModelMapRuntimeIds(config.agents?.defaults?.models);
  const agents = listAgentEntries(config);
  for (const agent of agents) {
    pushModelMapRuntimeIds(isRecord(agent) ? agent.models : undefined);
  }
}

function pushConfiguredAgentModelRuntimeIds(
  config: OpenClawConfig,
  runtimes: Set<string>,
  includeImplicitRuntimePreferences: boolean,
): void {
  const pushModelRefs = (
    modelRefs: string[],
    modelRefKind: ConfiguredModelRef["kind"],
    agentId?: string,
  ) => {
    for (const modelRef of modelRefs) {
      const runtime = resolveConfiguredModelHarnessRuntime({
        config,
        includeImplicitRuntimePreferences,
        modelRef,
        modelRefKind,
        agentId,
      });
      if (runtime) {
        runtimes.add(runtime);
      }
    }
  };
  const pushModelMapRefs = (models: unknown, agentId?: string) => {
    if (!isRecord(models)) {
      return;
    }
    pushModelRefs(Object.keys(models), "literal", agentId);
  };

  const defaultsModel = config.agents?.defaults?.model;
  pushModelRefs(listModelRefsFromConfigValue(defaultsModel), "selector");
  pushModelMapRefs(config.agents?.defaults?.models);

  for (const agent of listAgentEntries(config)) {
    if (!isRecord(agent)) {
      continue;
    }
    const agentId = typeof agent.id === "string" ? agent.id : undefined;
    pushModelRefs(listModelRefsFromConfigValue(agent.model ?? defaultsModel), "selector", agentId);
    pushModelMapRefs(agent.models, agentId);
  }
}

/** Options for collecting configured agent harness runtimes. */
export type ConfiguredAgentHarnessRuntimeOptions = {
  includeImplicitRuntimePreferences?: boolean;
};

/** Lists configured plugin harness runtime ids referenced by agent/model config. */
export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  options: ConfiguredAgentHarnessRuntimeOptions = {},
): string[] {
  // Roster facts are memoized for the whole batch: per-reference policy
  // resolution otherwise re-projects the roster O(agents × models) times,
  // which blocks the event loop on large fleets (#135743). The batch is a
  // pure read of config.
  return withAgentRosterFactsBatch(config, () => {
    const runtimes = new Set<string>();
    const includeImplicitRuntimePreferences = options.includeImplicitRuntimePreferences ?? true;

    pushConfiguredModelRuntimeIds(config, runtimes);
    pushConfiguredAgentModelRuntimeIds(config, runtimes, includeImplicitRuntimePreferences);

    return [...runtimes].toSorted((left, right) => left.localeCompare(right));
  });
}
