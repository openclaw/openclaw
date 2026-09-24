// OpenAI Responses tool helpers convert runtime tools to Responses API schemas.
import type { FunctionTool } from "openai/resources/responses/responses.js";
import { getAiTransportHost } from "../host.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import { resolveOpenAIStrictToolFlagWithDiagnostics } from "../transports/openai-transport-params.js";
import type { Model, Tool } from "../types.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import { prepareOpenAITools } from "./openai-tool-projection.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "./openai-tool-schema.js";
import { withPreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

/** Options for converting internal tool schemas to OpenAI Responses function tools. */
interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  model?: Model;
  supportsStrictMode?: boolean;
}

type OpenAIToolSchemaCompat = Parameters<typeof normalizeOpenAIStrictToolParameters>[2];
type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
};

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
  );
}

/** The transport has already resolved policy before descriptor projection. */
export function prepareResponsesTools(
  tools: Tool[],
  strictSetting: boolean | null | undefined,
  model?: Model,
) {
  const prepared = prepareOpenAITools(tools);
  return {
    projection: prepared.projection,
    tools: convertPreparedResponsesTools(prepared, strictSetting, model),
  };
}

function convertPreparedResponsesTools(
  prepared: ReturnType<typeof prepareOpenAITools>,
  strictSetting: boolean | null | undefined,
  model?: Model,
): FunctionTool[] {
  const { projection, schemas } = prepared;
  return withPreparedToolSchemaNormalization(schemas, () => {
    const strict = model
      ? resolveOpenAIStrictToolFlagWithDiagnostics(projection, strictSetting, {
          transport: "responses",
          model,
        })
      : resolveOpenAIProjectedToolsStrictToolFlag(projection, strictSetting);
    // Sort tools before request construction so prompt-cache bytes stay deterministic.
    return sortPromptCacheToolsByName(projection.tools).map((tool) => {
      const result: ResponsesFunctionTool = {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model?.compat as OpenAIToolSchemaCompat,
        ),
      };
      if (strict !== undefined) {
        result.strict = strict;
      }
      // Compatible endpoints can require strict to be absent; the SDK declares it required.
      return result as FunctionTool;
    });
  });
}

function resolveResponsesStrictToolSetting(
  options: ConvertResponsesToolsOptions | undefined,
): boolean | null | undefined {
  if (options?.strict !== undefined) {
    return options.strict;
  }
  if (options?.model) {
    return getAiTransportHost().resolveOpenAIStrictToolSetting(options.model, {
      transport: "stream",
      supportsStrictMode:
        options.supportsStrictMode ??
        resolveOpenAICompletionsCompat(options.model).supportsStrictMode,
    });
  }
  return false;
}
