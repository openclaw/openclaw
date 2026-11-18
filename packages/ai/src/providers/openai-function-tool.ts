import { getPublishedRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

type OpenAIFunctionDescriptor = {
  name: string;
  description: string | undefined;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export function prepareOpenAIFunctionTool(
  name: string,
  description: string | undefined,
  parameters: Record<string, unknown>,
  strict: boolean | undefined,
  mutableParameters = false,
): {
  responses: OpenAIFunctionDescriptor & { type: "function" };
  completions: { type: "function"; function: OpenAIFunctionDescriptor };
} {
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
