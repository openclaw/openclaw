import { getPublishedRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

type OpenAIFunctionDescriptor = {
  name: string;
  description: string | undefined;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

type PreparedOpenAIFunctionTool = {
  responses: OpenAIFunctionDescriptor & { type: "function" };
  completions: { type: "function"; function: OpenAIFunctionDescriptor };
};

export function prepareOpenAIFunctionTool(
  name: string,
  description: string | undefined,
  parameters: Record<string, unknown>,
  strict: boolean | undefined,
  mutableParameters = false,
): PreparedOpenAIFunctionTool {
  // Payload hooks own writable parameters; serialization can share published schemas.
  const descriptor: OpenAIFunctionDescriptor = {
    name,
    description,
    parameters:
      mutableParameters && getPublishedRuntimeToolInputSchema(parameters)
        ? structuredClone(parameters)
        : parameters,
    ...(strict !== undefined ? { strict } : {}),
  };
  return {
    responses: { type: "function", ...descriptor },
    completions: { type: "function", function: descriptor },
  };
}
