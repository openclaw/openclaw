import type { ThinkLevel } from "../auto-reply/thinking.js";
import { findReasoningModelFamily, isReasoningFamilyAllowed } from "./model-families.js";

export type ThinkingAwareModelRef = {
  provider: string;
  model: string;
};

export function resolveThinkingAwareModelRef(params: {
  provider: string;
  model: string;
  thinkingLevel?: ThinkLevel;
  allowedModelKeys?: Set<string>;
}): ThinkingAwareModelRef {
  const family = findReasoningModelFamily(params.provider, params.model);
  if (!family || !params.thinkingLevel) {
    return { provider: params.provider, model: params.model };
  }

  const candidateModel =
    params.thinkingLevel === "off" ? family.nonReasoningModel : family.reasoningModel;
  if (
    !isReasoningFamilyAllowed({
      provider: params.provider,
      baseModel: params.model,
      candidateModel,
      allowedModelKeys: params.allowedModelKeys,
    })
  ) {
    return { provider: params.provider, model: params.model };
  }

  return {
    provider: params.provider,
    model: candidateModel,
  };
}
