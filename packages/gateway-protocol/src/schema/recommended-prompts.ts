import { Type } from "typebox";
import {
  MAX_PLUGIN_RECOMMENDED_PROMPTS,
  MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH,
} from "../../../plugin-package-contract/src/recommended-prompts.js";

export const RecommendedPromptsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH }),
  { maxItems: MAX_PLUGIN_RECOMMENDED_PROMPTS },
);
