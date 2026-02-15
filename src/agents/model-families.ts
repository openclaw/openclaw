import { modelKey, normalizeProviderId } from "./model-selection.js";

export type ReasoningModelFamily = {
  provider: string;
  members: string[];
  reasoningModel: string;
  nonReasoningModel: string;
};

const REASONING_MODEL_FAMILIES: ReasoningModelFamily[] = [
  {
    provider: "xai",
    members: ["grok-4-1-fast", "grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning"],
    reasoningModel: "grok-4-1-fast-reasoning",
    nonReasoningModel: "grok-4-1-fast-non-reasoning",
  },
];

export function findReasoningModelFamily(
  provider: string,
  model: string,
): ReasoningModelFamily | undefined {
  const providerKey = normalizeProviderId(provider);
  const modelKeyLower = model.trim().toLowerCase();
  if (!providerKey || !modelKeyLower) {
    return undefined;
  }
  return REASONING_MODEL_FAMILIES.find(
    (family) =>
      normalizeProviderId(family.provider) === providerKey &&
      family.members.some((entry) => entry.toLowerCase() === modelKeyLower),
  );
}

export function isReasoningFamilyAllowed(params: {
  provider: string;
  baseModel: string;
  candidateModel: string;
  allowedModelKeys?: Set<string>;
}): boolean {
  const allowed = params.allowedModelKeys;
  if (!allowed || allowed.size === 0) {
    return true;
  }

  const base = modelKey(params.provider, params.baseModel);
  const candidate = modelKey(params.provider, params.candidateModel);
  return allowed.has(candidate) || allowed.has(base);
}
