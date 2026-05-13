import type { StreamFn } from "./agent-core-contract.js";
import {
  getApiProvider,
  registerApiProvider,
  type Api,
  type StreamOptions,
} from "./pi-ai-contract.js";

const CUSTOM_API_SOURCE_PREFIX = "openclaw-custom-api:";

export function getCustomApiRegistrySourceId(api: Api): string {
  return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}

export function ensureCustomApiRegistered(api: Api, streamFn: StreamFn): boolean {
  if (getApiProvider(api)) {
    return false;
  }

  registerApiProvider(
    {
      api,
      stream: (model, context, options) =>
        streamFn(model, context, options) as unknown as ReturnType<
          NonNullable<ReturnType<typeof getApiProvider>>["stream"]
        >,
      streamSimple: (model, context, options) =>
        streamFn(model, context, options as StreamOptions) as unknown as ReturnType<
          NonNullable<ReturnType<typeof getApiProvider>>["stream"]
        >,
    },
    getCustomApiRegistrySourceId(api),
  );
  return true;
}
