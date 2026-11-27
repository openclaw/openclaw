import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentEntries, resolveAgentConfig } from "./agent-scope-config.js";

/** A defined empty agent value disables decisions rather than inheriting the default. */
export function resolveDecisionModelSetting(config: OpenClawConfig, agentId?: string) {
  const value =
    (agentId ? resolveAgentConfig(config, agentId)?.decisionModel : undefined) ??
    config.agents?.defaults?.decisionModel;
  return value ? (parseProviderModelRef(value) ?? undefined) : undefined;
}

/** Activation includes explicitly selected providers throughout the configured fleet. */
export function getConfiguredDecisionProviderIds(config: OpenClawConfig): string[] {
  const refs = [
    config.agents?.defaults?.decisionModel,
    ...listAgentEntries(config).map((entry) => entry.decisionModel),
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
