import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AssembleResult } from "../../context-engine/types.js";
import { fingerprint } from "../agent-hooks/compaction-safeguard-semantic.js";

type Config = NonNullable<AgentDefaultsConfig["turnContextCuration"]>;
export function resolveTurnCurationPolicy(
  assembled: AssembleResult,
  config: Config,
  modelId?: string,
) {
  const metadata = assembled.semanticCurationCandidates;
  const economics = config.economics;
  if (
    !metadata ||
    !Array.isArray(metadata.discretionaryMessageIndexes) ||
    metadata.discretionaryMessageIndexes.length > Math.min(4096, assembled.messages.length) ||
    !Array.isArray(metadata.requiredIdentifiers) ||
    metadata.requiredIdentifiers.length > 64 ||
    metadata.requiredIdentifiers.some(
      (id) => typeof id !== "string" || !id.trim() || id.length > 256,
    ) ||
    !metadata.discretionaryMessageIndexes.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < assembled.messages.length,
    )
  ) {
    return undefined;
  }
  if (
    !economics ||
    !modelId ||
    economics.modelId !== modelId ||
    !Number.isFinite(economics.savedMsPerEstimatedToken) ||
    economics.savedMsPerEstimatedToken <= 0 ||
    !Number.isFinite(economics.decisionOverheadMs) ||
    economics.decisionOverheadMs < 0 ||
    !Number.isFinite(economics.cachePenaltyMs) ||
    economics.cachePenaltyMs < 0
  ) {
    return undefined;
  }
  return {
    discretionary: new Set(metadata.discretionaryMessageIndexes),
    requiredIdentifiers: [...metadata.requiredIdentifiers],
    fingerprint: fingerprint(metadata),
    savedMsPerEstimatedToken: economics.savedMsPerEstimatedToken,
    overheadMs: economics.decisionOverheadMs,
    cachePenaltyMs: economics.cachePenaltyMs,
  };
}
