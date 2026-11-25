import type {
  ProviderFailoverErrorContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripGoogleProviderPrefix } from "./model-id.js";
import {
  isGoogleVertexBaseUrl,
  resolveGoogleServiceTier,
  resolveGoogleThinkingProfile,
} from "./provider-policy.js";
import { sanitizeGoogleThinkingPayload } from "./thinking-api.js";

function isGoogleUltraPlanRefusal({ errorMessage }: ProviderFailoverErrorContext): boolean {
  return /requires an active Google AI Ultra subscription/i.test(errorMessage);
}

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderToolCompatFamilyHooks("gemini"),
  resolveThinkingProfile: resolveGoogleThinkingProfile,
  wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
    createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
      if (
        model.api !== "google-generative-ai" &&
        model.api !== "google-vertex" &&
        model.api !== "google-interactions"
      ) {
        return;
      }
      if (model.api === "google-generative-ai" || model.api === "google-vertex") {
        sanitizeGoogleThinkingPayload({
          payload,
          modelId: stripGoogleProviderPrefix(model.id).replace(/^models\//u, ""),
          thinkingLevel: ctx.thinkingLevel,
        });
      }
      if (
        model.api === "google-interactions" &&
        normalizeLowercaseStringOrEmpty(model.provider) === "google" &&
        !isGoogleVertexBaseUrl(model.baseUrl)
      ) {
        const serviceTier = resolveGoogleServiceTier(ctx.extraParams);
        if (serviceTier) {
          payload.service_tier = serviceTier;
        }
      }
    }),
  formatBillingError: (context: ProviderFailoverErrorContext) =>
    isGoogleUltraPlanRefusal(context)
      ? {
          message: "This request requires an active Google AI Ultra subscription.",
          actionUrl: "https://one.google.com/about/google-ai-plans/",
        }
      : undefined,
  // Google-family gRPC status codes stay with the shared Gemini provider hook.
  classifyFailoverReason: (context: ProviderFailoverErrorContext) => {
    if (isGoogleUltraPlanRefusal(context)) {
      return "billing" as const;
    }
    switch (context.code?.trim().toUpperCase()) {
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
