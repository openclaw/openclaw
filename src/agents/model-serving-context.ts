import type { Model } from "../llm/types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";

/** Live serving evidence, separate from authored or static model metadata. Never persisted. */
export type ModelServingContextLimit = {
  id: string;
  api: string;
  baseUrl: string;
  tokens: number;
};

export type ProviderServingContextLimits = ReadonlyMap<string, readonly ModelServingContextLimit[]>;

type ModelWithServingContextLimit = Pick<Model, "id"> &
  Partial<Pick<Model, "api" | "baseUrl">> & {
    servingContextLimit?: ModelServingContextLimit;
  };

/** An endpoint override cannot borrow the original server's observed capacity. */
export function readModelServingContextWindow(
  model: ModelWithServingContextLimit,
): number | undefined {
  const limit = model.servingContextLimit;
  return limit &&
    limit.id === model.id &&
    model.api === limit.api &&
    model.baseUrl &&
    modelTransportRoutesMatch(limit, model)
    ? limit.tokens
    : undefined;
}

/** Project only accepted same-route evidence after authored catalog merging has finished. */
export function applyModelServingContextLimit(
  model: Model,
  limits: ProviderServingContextLimits,
): Model & ModelWithServingContextLimit {
  const servingContextLimit = limits
    .get(model.provider)
    ?.find((limit) => limit.id === model.id && modelTransportRoutesMatch(limit, model));
  return servingContextLimit ? { ...model, servingContextLimit } : model;
}
