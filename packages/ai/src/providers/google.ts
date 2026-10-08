import { GoogleGenAI, type HttpOptions } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { buildManagedModelFetch } from "../transports/host-policy.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import { mergeTransportHeaders } from "../transports/transport-stream-shared.js";
import type { Model } from "../types.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { createGoogleGenerateContentStreams } from "./google-provider-stream.js";

export const { stream: streamGoogle, streamSimple: streamSimpleGoogle } =
  createGoogleGenerateContentStreams(
    "google-generative-ai",
    (model, options) => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      return createClient(model, apiKey, resolveOpencodeSessionHeaders(model, options));
    },
    (model, options) => requireApiKey(model.provider, options?.apiKey),
  );

function createClient(
  model: Model<"google-generative-ai">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  const httpOptions: HttpOptions = {};
  const fetcher = buildManagedModelFetch(model);
  if (fetcher) {
    httpOptions.fetch = fetcher;
  }
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels(
      mergeTransportHeaders(model.headers, optionsHeaders),
    );
  }

  // Authentication is resolved before construction; the SDK also retains the host fetch policy.
  const resolvedApiKey = apiKey ? getAiTransportHost().resolveSecretSentinel(apiKey) : undefined;
  return new GoogleGenAI({
    apiKey: resolvedApiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}
