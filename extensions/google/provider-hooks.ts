import type {
  ProviderFailoverErrorContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { resolveGoogleThinkingProfile } from "./provider-policy.js";
import { sanitizeGoogleThinkingPayload } from "./thinking-api.js";

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderToolCompatFamilyHooks("gemini"),
  resolveThinkingProfile: resolveGoogleThinkingProfile,
  wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
    createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
      if (model.api !== "google-generative-ai" && model.api !== "google-vertex") {
        return;
      }
      sanitizeGoogleThinkingPayload({
        payload,
        modelId: stripGoogleProviderPrefix(model.id).replace(/^models\//u, ""),
        thinkingLevel: ctx.thinkingLevel,
      });
    }),
  // Google-family gRPC status codes stay with the shared Gemini provider hook.
  classifyFailoverReason: ({ code }: ProviderFailoverErrorContext) => {
    switch (code?.trim().toUpperCase()) {
      case "UNAVAILABLE":
        return "overloaded" as const;
      case "DEADLINE_EXCEEDED":
        return "timeout" as const;
      case "INTERNAL":
        return "server_error" as const;
      default:
        return undefined;
    }
  },
};
