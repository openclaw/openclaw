import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { isProxyReasoningUnsupportedModelHint } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOpenAICompatibleReasoningPayload,
  wrapProviderPayloadHook,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

function normalizeKilocodeStopAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown> | undefined,
): unknown {
  const payload = asOptionalRecord(value) ?? fallbackPayload;
  if (typeof payload?.stop === "string") {
    payload.stop = [payload.stop];
  }
  return value;
}

export function wrapKilocodeProviderStream(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  if (normalizeOptionalLowercaseString(ctx.provider) !== "kilocode" || !ctx.streamFn) {
    return undefined;
  }
  const underlying = ctx.streamFn;
  const thinkingLevel =
    ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupportedModelHint(ctx.modelId)
      ? undefined
      : ctx.thinkingLevel;
  return (model, context, options) => {
    const headers = resolveProviderRequestHeaders({
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      defaultHeaders: { "X-KILOCODE-FEATURE": process.env.KILOCODE_FEATURE?.trim() || "openclaw" },
      precedence: "defaults-win",
    });
    return underlying(model, context, {
      ...options,
      headers,
      onPayload: wrapProviderPayloadHook(
        options?.onPayload,
        (payload, result) => normalizeKilocodeStopAfterCaller(result, asOptionalRecord(payload)),
        (payload) => {
          const payloadObj = asOptionalRecord(payload);
          if (payloadObj) {
            // Caller hooks can override thinking defaults; stop normalization runs afterward.
            normalizeOpenAICompatibleReasoningPayload(payloadObj, thinkingLevel);
          }
        },
      ),
    });
  };
}
