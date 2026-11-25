import { classifyOpenAIBaseUrl } from "./base-url.js";
import { OPENAI_DAYBREAK_MODEL_IDS } from "./model-route-contract.js";

/** Alias capabilities are independent of the snapshot behind each Daybreak name. */
export function resolveOpenAIModelServiceTiers(params: {
  modelId: string;
  api?: string;
  baseUrl?: string;
}): readonly string[] | undefined {
  if (params.api !== "openai-responses" || classifyOpenAIBaseUrl(params.baseUrl) !== "platform") {
    return undefined;
  }
  const [blue, red] = OPENAI_DAYBREAK_MODEL_IDS;
  return params.modelId === blue
    ? ["default", "priority"]
    : params.modelId === red
      ? ["default"]
      : undefined;
}
