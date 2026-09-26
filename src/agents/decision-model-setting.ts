import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionTaskId } from "../decisions/task-ids.js";
import { listAgentEntries, resolveAgentConfig } from "./agent-scope-config.js";

function hasOwnTaskSelection(
  values: Readonly<Record<string, string>> | undefined,
  taskId: DecisionTaskId | undefined,
): string | undefined {
  if (!values || taskId === undefined || !Object.hasOwn(values, taskId)) {
    return undefined;
  }
  return values[taskId];
}

/** Resolve a task-aware model while preserving explicit empty-value disablement. */
export function resolveDecisionModelSelection(
  config: OpenClawConfig,
  agentId?: string,
  taskId?: DecisionTaskId,
) {
  const agent = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const defaults = config.agents?.defaults;
  const candidates =
    agent?.decisionModel === ""
      ? ([["agent", ""]] as const)
      : ([
          ["agent-task", hasOwnTaskSelection(agent?.decisionModelsByTask, taskId)],
          ["global-task", hasOwnTaskSelection(defaults?.decisionModelsByTask, taskId)],
          ["agent", agent?.decisionModel],
          ["default", defaults?.decisionModel],
        ] as const);
  const [source, value] =
    candidates.find(([, candidate]) => candidate !== undefined) ?? (["none", undefined] as const);
  return {
    source,
    taskId,
    disabled: value === "",
    selection: value ? (parseProviderModelRef(value) ?? undefined) : undefined,
  };
}

/** A defined empty agent value disables decisions rather than inheriting the default. */
export function resolveDecisionModelSetting(
  config: OpenClawConfig,
  agentId?: string,
  taskId?: DecisionTaskId,
) {
  return resolveDecisionModelSelection(config, agentId, taskId).selection;
}

/** Activation includes explicitly selected providers throughout the configured fleet. */
export function getConfiguredDecisionProviderIds(config: OpenClawConfig): string[] {
  const agentEntries = listAgentEntries(config);
  const refs = [
    config.agents?.defaults?.decisionModel,
    ...Object.values(config.agents?.defaults?.decisionModelsByTask ?? {}),
    ...agentEntries.flatMap((entry) =>
      entry.decisionModel === ""
        ? []
        : [entry.decisionModel].concat(Object.values(entry.decisionModelsByTask ?? {})),
    ),
  ];
  return [
    ...new Set(
      refs.flatMap((ref) => {
        const selection = ref ? parseProviderModelRef(ref) : null;
        return selection ? [selection.provider] : [];
      }),
    ),
  ];
}
