import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { log } from "../logger.js";
import type { DecisionPrefilterResult } from "./attempt-decision-prefilter.js";

export type DecisionModelTool = { name: string; description?: string; parameters?: unknown };
export type DecisionToolSurface = {
  visibleCount: number;
  definitionJsonChars: number;
  requiredCount: number;
};

/** Normalized model-input JSON characters, NOT provider wire bytes, tokens or cost. */
export function measureDecisionToolSurface(
  readTools: () => readonly DecisionModelTool[],
  requiredNames: readonly string[] = [],
): DecisionToolSurface | undefined {
  if (!log.isEnabled("debug")) {
    return undefined;
  }
  try {
    const required = new Set(requiredNames.map(normalizeToolPolicyName));
    const tools = readTools();
    const definitions = tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    return {
      visibleCount: tools.length,
      definitionJsonChars: JSON.stringify(definitions).length,
      requiredCount: tools.filter((tool) => required.has(normalizeToolPolicyName(tool.name)))
        .length,
    };
  } catch {
    // Optional measurement cannot fail a turn or expose schema/getter error text.
    return undefined;
  }
}

/** Invoked only at the guarded first foreground dispatch, never on a proposal. */
export function logDecisionToolRequest(params: {
  decision: DecisionPrefilterResult;
  baseline?: DecisionToolSurface;
  readFinal: () => readonly DecisionModelTool[];
  requiredNames?: readonly string[];
  trace: DiagnosticTraceContext;
}): void {
  if (!log.isEnabled("debug")) {
    return;
  }
  const final = measureDecisionToolSurface(params.readFinal, params.requiredNames);
  const before = params.baseline;
  const delta =
    before && final ? before.definitionJsonChars - final.definitionJsonChars : undefined;
  log.debug("Decision tool surface at primary dispatch", {
    trace: params.trace,
    stage: "primary-dispatch",
    providerAcceptance: "not-observed",
    decisionStatus: params.decision.status,
    reason: params.decision.reason,
    restrictionRequested: params.decision.shouldPruneTools,
    restrictionApplied: params.decision.restrictionApplied === true,
    surfaceEffect:
      !before || !final
        ? "unknown"
        : delta !== undefined && delta > 0
          ? "reduced"
          : "unchanged-or-expanded",
    decisionLatencyMs: params.decision.latencyMs ?? null,
    contextExchanges: params.decision.context?.exchangeCount ?? 0,
    contextChars: params.decision.context?.contextChars ?? 0,
    olderContextOmitted: params.decision.context?.olderContextOmitted ?? false,
    toolPayloadsOmitted: params.decision.context?.toolPayloadsOmitted ?? false,
    measurement: "normalized-model-tool-definition-json-utf16-chars",
    baselineVisibleTools: before?.visibleCount ?? null,
    finalVisibleTools: final?.visibleCount ?? null,
    requiredRetained: final?.requiredCount ?? null,
    baselineDefinitionChars: before?.definitionJsonChars ?? null,
    finalDefinitionChars: final?.definitionJsonChars ?? null,
    definitionCharsSaved: delta ?? null,
    toolPromptGuidanceDelta: "not-measured",
    providerWireEncodingDelta: "not-measured",
  });
}
