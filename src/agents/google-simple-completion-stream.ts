import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, type Api, type Model } from "@earendil-works/pi-ai";
import {
  sanitizeGoogleThinkingPayload,
  type GoogleThinkingInputLevel,
} from "../plugin-sdk/provider-stream-shared.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { streamWithPayloadPatch } from "./pi-embedded-runner/stream-payload-utils.js";

/**
 * Custom api alias used to register an OpenClaw-owned simple-completion wrapper
 * around pi-ai's native Google generative-ai stream. The wrapper applies the
 * shared Google thinking-payload sanitizer so local model-run (and any other
 * simple-completion entry point) cannot leak `thinkingBudget: -1` to Google
 * for unknown Gemini aliases such as `gemini-flash-latest` whose canonical
 * thinking-level mapping is not recognized by upstream pi-ai.
 */
export const GOOGLE_SIMPLE_COMPLETION_API: Api =
  "openclaw-google-generative-ai-simple" as Api;

const SOURCE_API: Api = "google-generative-ai" as Api;

function resolveGoogleSimpleThinkingLevel(
  reasoning: unknown,
): GoogleThinkingInputLevel | undefined {
  if (typeof reasoning !== "string") {
    return undefined;
  }
  switch (reasoning) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "max":
    case "xhigh":
    case "adaptive":
      return reasoning;
    default:
      return undefined;
  }
}

function buildGoogleSimpleCompletionStreamFn(): StreamFn {
  return (model, context, options) => {
    const googleModel = { ...model, api: SOURCE_API } as Parameters<StreamFn>[0];
    return streamWithPayloadPatch(
      streamSimple as unknown as StreamFn,
      googleModel,
      context,
      options,
      (payload) => {
        sanitizeGoogleThinkingPayload({
          payload,
          modelId: model.id,
          thinkingLevel: resolveGoogleSimpleThinkingLevel(
            (options as { reasoning?: unknown } | undefined)?.reasoning,
          ),
        });
      },
    );
  };
}

/**
 * Swap a Google generative-ai model onto an OpenClaw-owned simple-completion
 * api alias whose stream wrapper applies the shared Google thinking sanitizer.
 *
 * Returns the original model unchanged for non-Google APIs.
 */
export function prepareGoogleSimpleCompletionModel<TApi extends Api>(
  model: Model<TApi>,
): Model<Api> {
  if (model.api !== SOURCE_API) {
    return model as Model<Api>;
  }
  ensureCustomApiRegistered(
    GOOGLE_SIMPLE_COMPLETION_API,
    buildGoogleSimpleCompletionStreamFn(),
  );
  return { ...model, api: GOOGLE_SIMPLE_COMPLETION_API } as Model<Api>;
}
