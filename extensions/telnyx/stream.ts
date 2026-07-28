/** Telnyx request payload policy for the OpenAI-compatible completions endpoint. */
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

/** Drops token caps from tool requests; Telnyx rejects the combination (error 10015). */
export function createTelnyxToolPayloadWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    if (model.provider !== "telnyx" || model.api !== "openai-completions") {
      return;
    }
    // Telnyx error 10015: max_completion_tokens (former max_tokens) and
    // function tools cannot be used in the same request. Agent turns always
    // carry tools, so the cap must yield or every tool request 400s.
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      delete payload.max_tokens;
      delete payload.max_completion_tokens;
    }
  });
}
