import type { AgentEmbeddedHarnessConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "../agent-scope.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import {
  normalizeEmbeddedAgentRuntime,
  resolveEmbeddedAgentHarnessFallback,
  resolveEmbeddedAgentRuntime,
  type EmbeddedAgentHarnessFallback,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  fallback: EmbeddedAgentHarnessFallback;
};

// Operator-facing record of the most recent harness selections. Used by
// `/acp doctor` and similar diagnostics to answer "did this actually run in
// Codex or did it silently fall back to PI?" without parsing logs.
export type HarnessSelectionDiagnostic = {
  ts: number;
  agentId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  requestedRuntime: EmbeddedAgentRuntime;
  selectedHarnessId: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
};

const HARNESS_SELECTION_DIAGNOSTIC_RING_SIZE = 16;
const harnessSelectionDiagnostics: HarnessSelectionDiagnostic[] = [];

function recordHarnessSelectionDiagnostic(entry: HarnessSelectionDiagnostic): void {
  harnessSelectionDiagnostics.push(entry);
  if (harnessSelectionDiagnostics.length > HARNESS_SELECTION_DIAGNOSTIC_RING_SIZE) {
    harnessSelectionDiagnostics.splice(
      0,
      harnessSelectionDiagnostics.length - HARNESS_SELECTION_DIAGNOSTIC_RING_SIZE,
    );
  }
}

export function readRecentHarnessSelectionDiagnostics(): HarnessSelectionDiagnostic[] {
  return harnessSelectionDiagnostics.slice();
}

export function clearHarnessSelectionDiagnosticsForTests(): void {
  harnessSelectionDiagnostics.length = 0;
}

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.harness.id.localeCompare(right.harness.id);
}

export function selectAgentHarness(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): AgentHarness {
  const policy = resolveAgentHarnessPolicy(params);
  // PI is intentionally not part of the plugin candidate list. It is the legacy
  // fallback path, so `fallback: "none"` can prove that only plugin harnesses run.
  const pluginHarnesses = listPluginAgentHarnesses();
  const piHarness = createPiAgentHarness();
  const runtime = policy.runtime;
  const recordSelection = (selectedHarnessId: string, fallbackReason?: string): void => {
    recordHarnessSelectionDiagnostic({
      ts: Date.now(),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      modelId: params.modelId,
      requestedRuntime: runtime,
      selectedHarnessId,
      fallbackUsed: Boolean(fallbackReason),
      ...(fallbackReason ? { fallbackReason } : {}),
    });
  };
  if (runtime === "pi") {
    recordSelection("pi");
    return piHarness;
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      recordSelection(forced.id);
      return forced;
    }
    if (policy.fallback === "none") {
      recordSelection("pi", "requested-not-registered;fallback-disabled");
      throw new Error(
        `Requested agent harness "${runtime}" is not registered and PI fallback is disabled.`,
      );
    }
    const reason = "requested-not-registered";
    log.warn("requested agent harness is not registered; falling back to embedded PI backend", {
      requestedRuntime: runtime,
      fallbackReason: reason,
    });
    recordSelection("pi", reason);
    return piHarness;
  }

  const supported = pluginHarnesses
    .map((harness) => ({
      harness,
      support: harness.supports({
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: runtime,
      }),
    }))
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
    recordSelection(selected.id);
    return selected;
  }
  if (policy.fallback === "none") {
    recordSelection("pi", "no-supporting-harness;fallback-disabled");
    throw new Error(
      `No registered agent harness supports ${formatProviderModel(params)} and PI fallback is disabled.`,
    );
  }
  recordSelection("pi", "no-supporting-harness");
  return piHarness;
}

export async function runAgentHarnessAttemptWithFallback(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const harness = selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (harness.id === "pi") {
    return harness.runAttempt(params);
  }

  try {
    return await harness.runAttempt(params);
  } catch (error) {
    log.warn(`${harness.label} failed; not falling back to embedded PI backend`, {
      harnessId: harness.id,
      provider: params.provider,
      modelId: params.modelId,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult | undefined> {
  const harness = selectAgentHarness({
    provider: params.provider ?? "",
    modelId: params.model,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  if (!harness.compact) {
    return undefined;
  }
  return harness.compact(params);
}

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const env = params.env ?? process.env;
  // Harness policy can be session-scoped because users may switch between agents
  // with different strictness requirements inside the same gateway process.
  const agentPolicy = resolveAgentEmbeddedHarnessConfig(params.config, {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const defaultsPolicy = params.config?.agents?.defaults?.embeddedHarness;
  const runtime = env.OPENCLAW_AGENT_RUNTIME?.trim()
    ? resolveEmbeddedAgentRuntime(env)
    : normalizeEmbeddedAgentRuntime(agentPolicy?.runtime ?? defaultsPolicy?.runtime);
  return {
    runtime,
    fallback:
      resolveEmbeddedAgentHarnessFallback(env) ??
      normalizeAgentHarnessFallback(agentPolicy?.fallback ?? defaultsPolicy?.fallback),
  };
}

function resolveAgentEmbeddedHarnessConfig(
  config: OpenClawConfig | undefined,
  params: { agentId?: string; sessionKey?: string },
): AgentEmbeddedHarnessConfig | undefined {
  if (!config) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return listAgentEntries(config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)
    ?.embeddedHarness;
}

function normalizeAgentHarnessFallback(
  value: AgentEmbeddedHarnessConfig["fallback"] | undefined,
): EmbeddedAgentHarnessFallback {
  return value === "none" ? "none" : "pi";
}

function formatProviderModel(params: { provider: string; modelId?: string }): string {
  return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
