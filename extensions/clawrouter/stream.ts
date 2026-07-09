import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { prepareClawRouterRequestModel } from "./provider-catalog.js";

const ENV_API_KEY_MARKER = "CLAWROUTER_API_KEY";

function withBearerAuthorization(
  headers: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization") {
      next[name] = value;
    }
  }
  next.Authorization = `Bearer ${apiKey}`;
  return next;
}

function createClawRouterStreamWrapper(underlying: StreamFn | undefined): StreamFn | undefined {
  if (!underlying) {
    return undefined;
  }
  return (model, context, options) => {
    const apiKey = options?.apiKey?.trim();
    const preparedModel = prepareClawRouterRequestModel(model);
    if (!apiKey || apiKey === ENV_API_KEY_MARKER) {
      return underlying(preparedModel, context, options);
    }
    return underlying(
      {
        ...preparedModel,
        headers: withBearerAuthorization(preparedModel.headers, apiKey),
      },
      context,
      options,
    );
  };
}

export function wrapClawRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  return createClawRouterStreamWrapper(ctx.streamFn);
}
