import type {
  ProviderNormalizeToolSchemasContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildGoogleGeminiReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createGoogleThinkingPayloadWrapper } from "openclaw/plugin-sdk/provider-stream";
import {
  inspectGeminiToolSchemas,
  normalizeGeminiToolSchemas,
} from "openclaw/plugin-sdk/provider-tools";

type GoogleGeminiHookOptions = {
  includeToolSchemaCompat?: boolean;
};

export function buildGoogleGeminiProviderHooks(options: GoogleGeminiHookOptions = {}) {
  return {
    buildReplayPolicy: () => buildGoogleGeminiReplayPolicy(),
    wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
      createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel),
    sanitizeReplayHistory: (ctx: ProviderSanitizeReplayHistoryContext) =>
      sanitizeGoogleGeminiReplayHistory(ctx),
    resolveReasoningOutputMode: () => resolveTaggedReasoningOutputMode(),
    ...(options.includeToolSchemaCompat
      ? {
          normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) =>
            normalizeGeminiToolSchemas(ctx),
          inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) =>
            inspectGeminiToolSchemas(ctx),
        }
      : {}),
  };
}
