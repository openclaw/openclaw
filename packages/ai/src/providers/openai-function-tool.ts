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

const preparedTools = new WeakMap<object, PreparedOpenAIFunctionTool[]>();
const MAX_DESCRIPTOR_VARIANTS = 8;

/** Reuse wire descriptors only when their parameter owner published immutable JSON. */
export function prepareOpenAIFunctionTool(
  name: string,
  description: string | undefined,
  parameters: Record<string, unknown>,
  strict: boolean | undefined,
): PreparedOpenAIFunctionTool {
  const published = getPublishedRuntimeToolInputSchema(parameters);
  const variants = published ? preparedTools.get(parameters) : undefined;
  const cached = variants?.find(
    ({ responses }) =>
      responses.name === name &&
      responses.description === description &&
      responses.strict === strict,
  );
  if (cached) {
    return cached;
  }
  const descriptor: OpenAIFunctionDescriptor = {
    name,
    description,
    parameters,
    ...(strict !== undefined ? { strict } : {}),
  };
  const result: PreparedOpenAIFunctionTool = {
    responses: { type: "function", ...descriptor },
    completions: { type: "function", function: descriptor },
  };
  if (published) {
    Object.freeze(descriptor);
    Object.freeze(result.responses);
    Object.freeze(result.completions);
    Object.freeze(result);
    preparedTools.set(parameters, [result, ...(variants ?? [])].slice(0, MAX_DESCRIPTOR_VARIANTS));
  }
  return result;
}
