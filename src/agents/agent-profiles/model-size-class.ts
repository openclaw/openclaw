// Size class for Agent Profile selection (RFC 0009), derived from a trusted TOTAL parameter
// count. Mixture-of-experts models use total parameters, never active ones. Model ids, names
// and GGUF `general.size_label` are never used.

import type { ModelSizeClass } from "../../config/types.models.js";
import { MODEL_SIZE_CLASSES } from "../../config/types.models.js";

const SMALL_ABOVE = 1e9;
const MEDIUM_ABOVE = 20e9;
const LARGE_ABOVE = 50e9;

function classifyModelSize(totalParameters: unknown): ModelSizeClass | undefined {
  if (
    typeof totalParameters !== "number" ||
    !Number.isSafeInteger(totalParameters) ||
    totalParameters <= 0
  ) {
    return undefined;
  }
  if (totalParameters <= SMALL_ABOVE) {
    return "tiny";
  }
  if (totalParameters <= MEDIUM_ABOVE) {
    return "small";
  }
  if (totalParameters <= LARGE_ABOVE) {
    return "medium";
  }
  return "large";
}

/**
 * Size class handed to Agent Profile selection for a resolved model.
 * An explicit config class wins, then the route-matched total `parameterCount`,
 * else undefined, which selects the base profile.
 */
export function resolveProfileModelSizeClass(
  model:
    | { modelSizeClass?: ModelSizeClass | undefined; parameterCount?: number | undefined }
    | undefined,
): ModelSizeClass | undefined {
  if (model?.modelSizeClass && MODEL_SIZE_CLASSES.includes(model.modelSizeClass)) {
    return model.modelSizeClass;
  }
  return classifyModelSize(model?.parameterCount);
}
