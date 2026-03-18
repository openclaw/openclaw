import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  getApiProvider,
  registerApiProvider,
  type Api,
  type StreamOptions,
} from "@mariozechner/pi-ai";

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

// google-vertex ADC fix (#49194): pi-ai returns "<authenticated>" sentinel
// from getEnvApiKey which gets passed as a literal API key → 401.
type ProviderStreamOptions = Record<string, unknown>;

function stripAdcSentinel(options: unknown): unknown {
  if (
    options &&
    typeof options === "object" &&
    "apiKey" in options &&
    (options as ProviderStreamOptions).apiKey === "<authenticated>"
  ) {
    const { apiKey: _, ...rest } = options as ProviderStreamOptions;
    return rest;
  }
  return options;
}

let vertexAdcFixApplied = false;

export function installGoogleVertexAdcFix(): void {
  if (vertexAdcFixApplied) {
    return;
  }
  const original = getApiProvider("google-vertex" as Api);
  if (!original) {
    return;
  }
  vertexAdcFixApplied = true;
  registerApiProvider(
    {
      api: "google-vertex" as Api,
      stream: (model, context, options) =>
        original.stream(model, context, stripAdcSentinel(options) as typeof options),
      streamSimple: (model, context, options) =>
        original.streamSimple(model, context, stripAdcSentinel(options) as typeof options),
    },
    "openclaw-vertex-adc-fix",
  );
}
