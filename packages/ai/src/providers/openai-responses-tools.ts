import type { FunctionTool } from "openai/resources/responses/responses.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import type { Model, Tool } from "../types.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import { prepareOpenAIFunctionTool } from "./openai-function-tool.js";
import { prepareOpenAITools } from "./openai-tool-projection.js";
import {
  normalizeOpenAIToolParameters,
  resolveOpenAIStrictToolSetting,
} from "./openai-tool-schema.js";
import { withPreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

/** Options for converting internal tool schemas to OpenAI Responses function tools. */
interface ConvertResponsesToolsOptions {
  strict?: false;
  model?: Model;
  mutableParameters?: boolean;
}

/** Projects direct provider descriptors before resolving their strict policy. */
export function convertResponsesToolPayload(
  tools: Tool[],
  options?: ConvertResponsesToolsOptions,
): FunctionTool[] {
  const prepared = prepareOpenAITools(tools);
  return convertPreparedResponsesTools(
    prepared,
    resolveResponsesStrictToolSetting(options),
    options?.model,
    options?.mutableParameters,
  );
}

/** The transport has already resolved policy before descriptor projection. */
export function prepareResponsesTools(
  tools: Tool[],
  strict: false | undefined,
  model?: Model,
  mutableParameters?: boolean,
) {
  const prepared = prepareOpenAITools(tools);
  return {
    projection: prepared.projection,
    tools: convertPreparedResponsesTools(prepared, strict, model, mutableParameters),
  };
}

function convertPreparedResponsesTools(
  prepared: ReturnType<typeof prepareOpenAITools>,
  strict: false | undefined,
  model?: Model,
  mutableParameters?: boolean,
): FunctionTool[] {
  const { projection, schemas } = prepared;
  return withPreparedToolSchemaNormalization(schemas, () =>
    // Sort tools before request construction so prompt-cache bytes stay deterministic.
    sortPromptCacheToolsByName(projection.tools).map((tool) => {
      const result = prepareOpenAIFunctionTool(
        tool.name,
        tool.description,
        normalizeOpenAIToolParameters(
          tool.parameters,
          model?.compat as Parameters<typeof normalizeOpenAIToolParameters>[1],
        ),
        strict,
        mutableParameters,
      ).responses;
      // Compatible endpoints can require strict to be absent; the SDK declares it required.
      return result as FunctionTool;
    }),
  );
}

function resolveResponsesStrictToolSetting(
  options: ConvertResponsesToolsOptions | undefined,
): false | undefined {
  if (options?.strict !== undefined) {
    return options.strict;
  }
  return options?.model
    ? resolveOpenAIStrictToolSetting(resolveOpenAICompletionsCompat(options.model))
    : false;
}
