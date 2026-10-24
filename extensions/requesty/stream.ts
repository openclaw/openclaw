import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { REQUESTY_PROVIDER_ID } from "./provider-models.js";

// Requesty attributes traffic per client through these headers.
const REQUESTY_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
} as const;

export function wrapRequestyProviderStream(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  if (normalizeOptionalLowercaseString(ctx.provider) !== REQUESTY_PROVIDER_ID || !ctx.streamFn) {
    return undefined;
  }
  const underlying = ctx.streamFn;
  const wrapped: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: resolveProviderRequestHeaders({
        provider: typeof model.provider === "string" ? model.provider : REQUESTY_PROVIDER_ID,
        api: model.api,
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
        capability: "llm",
        transport: "stream",
        callerHeaders: options?.headers,
        defaultHeaders: REQUESTY_ATTRIBUTION_HEADERS,
        precedence: "defaults-win",
      }),
    });
  return Object.assign(wrapped, { preservesGenericCompatibility: true });
}
