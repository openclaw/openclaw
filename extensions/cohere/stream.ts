import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

export function createCohereCompletionsWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      // Cohere lets tool-capable models choose a tool when tool_choice is omitted.
      delete payload.tool_choice;
    },
    {
      shouldPatch: ({ model }) => model.provider === "cohere" && model.api === "openai-completions",
    },
  );
}
