// New-work-only candidate qualification against durable recovery fences.
import {
  createModelTargetFenceStore,
  type ModelTargetFence,
} from "../state/model-target-fence-store.js";
import type { ModelCandidate } from "./model-fallback.types.js";

export type ModelTargetFenceDenial = ModelCandidate & {
  reason: "target_diverted" | "resource_domain_conflict";
  fenceEpoch: number;
  resourceDomain: string | null;
};

export type ModelTargetFenceQualification =
  | {
      status: "available";
      allowed: ModelCandidate[];
      denied: ModelTargetFenceDenial[];
    }
  | {
      status: "capability_unavailable";
      allowed: [];
      denied: [];
      error: string;
    };

export class ModelTargetFenceUnavailableError extends Error {
  readonly code = "MODEL_TARGET_FENCE_UNAVAILABLE";
}

function sameTarget(left: ModelCandidate, right: ModelCandidate): boolean {
  return (
    left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim() === right.model.trim()
  );
}

export function qualifyModelCandidatesAgainstFences(
  candidates: readonly ModelCandidate[],
  activeFences: readonly ModelTargetFence[],
): ModelTargetFenceQualification {
  const allowed: ModelCandidate[] = [];
  const denied: ModelTargetFenceDenial[] = [];
  for (const candidate of candidates) {
    const exactFence = activeFences.find(
      (fence) => fence.state !== "released" && sameTarget(candidate, fence),
    );
    if (exactFence) {
      denied.push({
        ...candidate,
        reason: "target_diverted",
        fenceEpoch: exactFence.fenceEpoch,
        resourceDomain: exactFence.resourceDomain,
      });
      continue;
    }
    const resourceFence = activeFences.find(
      (fence) =>
        fence.state !== "released" &&
        fence.deniedTargets.some((target) => sameTarget(candidate, target)),
    );
    if (resourceFence) {
      denied.push({
        ...candidate,
        reason: "resource_domain_conflict",
        fenceEpoch: resourceFence.fenceEpoch,
        resourceDomain: resourceFence.resourceDomain,
      });
      continue;
    }
    allowed.push(candidate);
  }
  return { status: "available", allowed, denied };
}

export function requireQualifiedModelCandidates(
  result: ModelTargetFenceQualification,
): ModelCandidate[] {
  if (result.status === "capability_unavailable") {
    throw new ModelTargetFenceUnavailableError(
      `Model routing is unavailable because recovery fence state could not be verified: ${result.error}`,
    );
  }
  if (result.allowed.length > 0) {
    return result.allowed;
  }
  const descriptions = result.denied.map((entry, index) => {
    const target = `${entry.provider}/${entry.model}`;
    const domain = entry.resourceDomain ?? "shared model resources";
    if (entry.reason === "target_diverted") {
      return `${index === 0 ? "recovery diverted" : "diverted"} ${target}`;
    }
    return `blocked ${target} to protect resource domain ${domain}`;
  });
  throw new ModelTargetFenceUnavailableError(
    `No configured model is currently available: ${descriptions.join(" and ")}.`,
  );
}

let cachedSnapshot: readonly ModelTargetFence[] | null = null;

export function invalidateModelTargetFenceSnapshot(): void {
  cachedSnapshot = null;
}

export function qualifyModelCandidatesForNewWork(
  candidates: readonly ModelCandidate[],
): ModelTargetFenceQualification {
  try {
    cachedSnapshot ??= createModelTargetFenceStore().status().activeFences;
    return qualifyModelCandidatesAgainstFences(candidates, cachedSnapshot);
  } catch (error) {
    return {
      status: "capability_unavailable",
      allowed: [],
      denied: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
