import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { isProxyReasoningUnsupportedModelHint } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOpenAICompatibleReasoningPayload } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

type ThinkLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;
type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

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

function resolveKilocodeThinkingLevel(ctx: ProviderWrapStreamFnContext): ThinkLevel | undefined {
  if (ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupportedModelHint(ctx.modelId)) {
    return undefined;
  }
  return ctx.thinkingLevel;
}

function createKilocodeStreamWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel?: ThinkLevel,
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    const headers = resolveProviderRequestHeaders({
      provider: typeof model.provider === "string" ? model.provider : "kilocode",
      api: model.api,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      defaultHeaders: resolveKilocodeAppHeaders(),
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

export function wrapKilocodeProviderStream(
  ctx: ProviderWrapStreamFnContext,
): ProviderStreamFn | undefined {
  if (normalizeOptionalLowercaseString(ctx.provider) !== "kilocode") {
    return undefined;
  }
  return createKilocodeStreamWrapper(ctx.streamFn, resolveKilocodeThinkingLevel(ctx));
}
