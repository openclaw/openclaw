import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { isProxyReasoningUnsupportedModelHint } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOpenAICompatibleReasoningPayload } from "openclaw/plugin-sdk/provider-stream-shared";
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
    const originalOnPayload = options?.onPayload;
    const headers = resolveProviderRequestHeaders({
      provider: typeof model.provider === "string" ? model.provider : "kilocode",
      api: model.api,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      defaultHeaders: { "X-KILOCODE-FEATURE": process.env.KILOCODE_FEATURE?.trim() || "openclaw" },
      precedence: "defaults-win",
    });
    return underlying(model, context, {
      ...options,
      headers,
      onPayload(payload, payloadModel) {
        const payloadObj = asOptionalRecord(payload);
        if (payloadObj) {
          // Keep Kilo thinking defaults overrideable by later caller/config payload hooks.
          normalizeOpenAICompatibleReasoningPayload(payloadObj, thinkingLevel);
        }

        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return Promise.resolve(result).then((resolved) =>
            normalizeKilocodeStopAfterCaller(resolved, payloadObj),
          );
        }
        return normalizeKilocodeStopAfterCaller(result, payloadObj);
      },
    });
  };
}
