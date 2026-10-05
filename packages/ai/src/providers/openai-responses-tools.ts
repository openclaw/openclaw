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
import { ToolSchemaDepthExceededError } from "./tool-schema-depth.js";
import { withPreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

/** Options for converting internal tool schemas to OpenAI Responses function tools. */
interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  model?: Model;
  supportsStrictMode?: boolean;
}

type OpenAIToolSchemaCompat = Parameters<typeof normalizeOpenAIStrictToolParameters>[2];
type ResponsesFunctionTool = Omit<FunctionTool, "strict"> & { strict?: boolean | null };

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
    const converted: FunctionTool[] = [];
    for (const tool of sortPromptCacheToolsByName(projection.tools)) {
      let parameters: unknown;
      try {
        parameters = normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model?.compat as OpenAIToolSchemaCompat,
        );
      } catch (error) {
        if (error instanceof ToolSchemaDepthExceededError) {
          // Contain the depth rejection at the tool boundary: one pathological
          // external schema must not abort preparation of every healthy sibling
          // tool, so the rejected tool is skipped (with a warning) instead.
          getAiTransportHost().logWarn(
            "[openai-tools]",
            `skipping tool with schema past the depth budget`,
            { tool: tool.name, message: error.message },
          );
          continue;
        }
        throw error;
      }
      const result: ResponsesFunctionTool = {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters,
      };
      if (strict !== undefined) {
        result.strict = strict;
      }
      // Compatible endpoints can require strict to be absent; the SDK declares it required.
      converted.push(result as FunctionTool);
    }
    return converted;
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
