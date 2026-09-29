import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDecisionModelSetting } from "./decision-model-setting.js";

/**
 * Outer eligibility only, over prepared config and a trusted owning agent ID.
 * Does not establish provider readiness, consumer mode, harness support, or
 * authority. Future automatic consumers check this before preparing evidence
 * and revalidate their current config/authority before applying awaited results.
 * Explicit decision_evaluate and the shared Decision runtime remain independent.
 */
export function isDecisionAssistanceEligible(config: OpenClawConfig, agentId: string): boolean {
  return (
    config.agents?.defaults?.experimental?.decisionAssistance === true &&
    resolveDecisionModelSetting(config, agentId) !== undefined
  );
}
