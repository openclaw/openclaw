import { Type } from "typebox";
import {
  MAX_PLUGIN_RECOMMENDED_PROMPTS,
  MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH,
} from "../../../plugin-package-contract/src/recommended-prompts.js";

export const RecommendedPromptSchema = Type.String({
  minLength: 1,
  maxLength: MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH,
});
export const RecommendedPromptsSchema = Type.Array(RecommendedPromptSchema, {
  maxItems: MAX_PLUGIN_RECOMMENDED_PROMPTS,
});
