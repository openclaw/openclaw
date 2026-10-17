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
): PreparedOpenAIFunctionTool {
  const descriptor: OpenAIFunctionDescriptor = {
    name,
    description,
    parameters,
    ...(strict !== undefined ? { strict } : {}),
  };
  return {
    responses: { type: "function", ...descriptor },
    completions: { type: "function", function: descriptor },
  };
}
