/** Synchronous harness selection facts, without loading invocation machinery. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProviderRefOwnership } from "../../plugins/providers.js";
import { isCliRuntimeAliasForProvider } from "../model-runtime-aliases.js";
import { resolveAgentHarnessAutoSelectionHint } from "./auto-selection.js";
import { resolveAgentHarnessAvailabilityDecision } from "./availability.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "./builtin-openclaw-metadata.js";
import { MissingAgentHarnessError } from "./errors.js";
import type { AgentHarnessPolicy } from "./policy.js";
import { listRegisteredAgentHarnesses, resolveAgentHarnessOwnerPluginId } from "./registry.js";
import { buildAgentHarnessSupportContext, compareHarnessSupport } from "./support.js";
import type { AgentHarness, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

const log = createSubsystemLogger("agents/harness");

export type AgentHarnessSelectionParams = {
  provider: string;
  modelId?: string;
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
};

export type AgentHarnessSelectionDecisionParams = AgentHarnessSelectionParams & {
  /** Finalized route/auth facts must always pass harness support, including persisted pins. */
  preparedModelProvider?: boolean;
};

export type AgentHarnessPreparedModelProvider = NonNullable<
  AgentHarnessSupportContext["modelProvider"]
>;

export type AgentHarnessSelectionCandidate = {
  id: string;
  label: string;
  pluginId?: string;
  supported?: boolean;
  priority?: number;
  reason?: string;
};

export type AgentHarnessSelectionDecision = {
  policy: AgentHarnessPolicy;
  selectedHarnessId: string;
  selectedReason:
    | "forced_openclaw"
    | "forced_plugin"
    // Implicit Codex preference found no registered Codex harness, so OpenClaw handled the run.
    | "implicit_plugin_unavailable_openclaw"
    // Implicit Codex preference cannot reproduce the prepared transport, so OpenClaw handled it.
    | "implicit_plugin_unsupported_openclaw"
    // The requested plugin declared OpenClaw as a lossless fallback for this prepared request.
    | "plugin_declared_fallback_openclaw"
    // Provider-owned CLI runtime aliases have no agent harness plugin counterpart.
    | "cli_runtime_passthrough_openclaw"
    // Auto mode chose a registered plugin harness that supports the provider/model.
    | "auto_plugin"
    // Auto mode found no supporting plugin harness, so OpenClaw handled the run.
    | "auto_openclaw";
  candidates: AgentHarnessSelectionCandidate[];
} & (
  | { builtIn: true; harness?: never; ownerPluginId?: never }
  | { builtIn: false; harness: AgentHarness; ownerPluginId: string }
);

/** Reads delivery policy from the same validated decision used for execution. */
export function resolveAgentHarnessDeliveryDefaults(
  params: AgentHarnessSelectionParams,
): AgentHarness["deliveryDefaults"] {
  const selection = resolveAgentHarnessSelectionDecision(params);
  return selection.builtIn
    ? BUILTIN_AGENT_HARNESS_METADATA.deliveryDefaults
    : selection.harness.deliveryDefaults;
}

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

export function resolveAgentHarnessSelectionDecision(
  params: AgentHarnessSelectionDecisionParams,
): AgentHarnessSelectionDecision {
  // Keep the probed instance: owner validation must reject replacement during supports().
  const pluginHarnesses = listPluginAgentHarnesses();
  const availability = resolveAgentHarnessAvailabilityDecision({
    ...params,
    resolveProviderOwnership: () =>
      resolveProviderRefOwnership({
        provider: params.provider,
        config: params.config,
      }),
  });
  const policy = availability.policy;
  // OpenClaw's built-in harness is intentionally not part of the plugin candidate list. Explicit plugin
  // runtimes fail closed unless the selected plugin declares OpenClaw as a lossless fallback.
  const runtime = policy.runtime;
  if (runtime === "openclaw") {
    const selectedReason =
      availability.kind === "implicit-unavailable"
        ? "implicit_plugin_unavailable_openclaw"
        : availability.kind === "implicit-unsupported"
          ? "implicit_plugin_unsupported_openclaw"
          : availability.kind === "declared-fallback"
            ? "plugin_declared_fallback_openclaw"
            : "forced_openclaw";
    return buildAgentHarnessSelectionDecision({
      policy,
      selectedReason,
      candidates: listHarnessCandidates(pluginHarnesses),
    });
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      const support = availability.support;
      if (!support || support.supported || support.fallbackRuntime === "openclaw") {
        if (support && !support.supported) {
          log.info(
            `agent harness selected requested=${runtime} selected=${forced.id} reason=private_qa_forced_runtime`,
          );
        }
        return buildAgentHarnessSelectionDecision({
          harness: forced,
          policy,
          selectedReason: "forced_plugin",
          candidates: listHarnessCandidates(pluginHarnesses),
        });
      }
      if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider })) {
        return buildAgentHarnessSelectionDecision({
          policy: {
            ...policy,
            runtime: "openclaw",
          },
          selectedReason: "cli_runtime_passthrough_openclaw",
          candidates: listHarnessCandidates(pluginHarnesses),
        });
      }
      throw new Error(
        `Requested agent harness "${runtime}" does not support ${formatProviderModel(params)}${
          support.reason ? ` (${support.reason})` : ""
        }.`,
      );
    }
    if (
      isCliRuntimeAliasForProvider({
        runtime,
        provider: params.provider,
        cfg: params.config,
      })
    ) {
      return buildAgentHarnessSelectionDecision({
        policy: {
          ...policy,
          runtime: "openclaw",
        },
        selectedReason: "cli_runtime_passthrough_openclaw",
        candidates: listHarnessCandidates(pluginHarnesses),
      });
    }
    throw new MissingAgentHarnessError(runtime);
  }

  const hintedCandidates = pluginHarnesses.map((harness) => ({
    harness,
    support: resolveAgentHarnessAutoSelectionHint({ harness, provider: params.provider }),
  }));
  const candidates = hintedCandidates.some((entry) => entry.support === undefined)
    ? (() => {
        const supportContext = buildAgentHarnessSupportContext({
          provider: params.provider,
          modelId: params.modelId,
          modelProvider: params.modelProvider,
          requestedRuntime: runtime,
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          preparedModelProvider: params.preparedModelProvider,
          providerOwnership: resolveProviderRefOwnership({
            provider: params.provider,
            config: params.config,
          }),
        });
        return hintedCandidates.map(({ harness, support }) => ({
          harness,
          support: support ?? harness.supports(supportContext),
        }));
      })()
    : hintedCandidates.map(({ harness, support }) => ({
        harness,
        // SAFETY: The preceding some() check established that every hint has support.
        support: support as AgentHarnessSupport,
      }));
  const supported = candidates
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .toSorted(compareHarnessSupport);

  const selected = supported[0]?.harness;
  if (selected) {
    return buildAgentHarnessSelectionDecision({
      harness: selected,
      policy,
      selectedReason: "auto_plugin",
      candidates: candidates.map(toSelectionCandidate),
    });
  }
  return buildAgentHarnessSelectionDecision({
    policy,
    selectedReason: "auto_openclaw",
    candidates: candidates.map(toSelectionCandidate),
  });
}

function listHarnessCandidates(harnesses: AgentHarness[]): AgentHarnessSelectionCandidate[] {
  return harnesses.map((harness) => ({
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
  }));
}

function toSelectionCandidate(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): AgentHarnessSelectionCandidate {
  return {
    id: entry.harness.id,
    label: entry.harness.label,
    pluginId: entry.harness.pluginId,
    supported: entry.support.supported,
    priority: entry.support.supported ? entry.support.priority : undefined,
    reason: entry.support.reason,
  };
}

export function buildAgentHarnessSelectionDecision(params: {
  harness?: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedReason: AgentHarnessSelectionDecision["selectedReason"];
  candidates: AgentHarnessSelectionCandidate[];
}): AgentHarnessSelectionDecision {
  const common = {
    policy: params.policy,
    selectedHarnessId: params.harness?.id ?? BUILTIN_AGENT_HARNESS_METADATA.id,
    selectedReason: params.selectedReason,
    candidates: params.candidates,
  };
  return params.harness
    ? {
        ...common,
        builtIn: false,
        harness: params.harness,
        ownerPluginId: resolveAgentHarnessOwnerPluginId(params.harness),
      }
    : { ...common, builtIn: true };
}

function formatProviderModel(params: { provider: string; modelId?: string }): string {
  return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
