import type {
  ProviderFailoverErrorContext,
  ProviderReplayPolicyContext,
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
  usesGoogleVertexTransport,
} from "./provider-policy.js";
import { sanitizeGoogleThinkingPayload } from "./thinking-api.js";

const googleReplayHooks = buildProviderReplayFamilyHooks({ family: "google-gemini" });

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...googleReplayHooks,
  buildReplayPolicy: (ctx: ProviderReplayPolicyContext) => {
    const policy = googleReplayHooks.buildReplayPolicy?.(ctx);
    if (
      usesGoogleVertexTransport({
        api: ctx.model?.api ?? ctx.modelApi,
        provider: ctx.model?.provider ?? ctx.provider,
        baseUrl: ctx.model?.baseUrl,
      })
    ) {
      // Keep Vertex history stable for implicit caching. The direct Gemini
      // transport's managed explicit cache uses a transient runtime suffix.
      return { ...policy, appendOnlyRuntimeContext: true };
    }
    return policy;
  },
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
