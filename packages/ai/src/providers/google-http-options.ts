import { type HttpOptions, ResourceScope } from "@google/genai";
import { resolveAiTransportHeaderSentinels } from "../host.js";
import { buildManagedModelFetch } from "../transports/host-policy.js";
import { mergeTransportHeaders } from "../transports/transport-stream-shared.js";
import type { Model } from "../types.js";

export function buildGoogleHttpOptions(
  model: Model<"google-generative-ai" | "google-vertex">,
  optionsHeaders: Record<string, string> | undefined,
  profile: "generative-ai" | "vertex",
): HttpOptions | undefined {
  const httpOptions: HttpOptions = {};
  const fetcher = buildManagedModelFetch(model);
  if (fetcher) {
    httpOptions.fetch = fetcher;
  }
  if (profile === "vertex") {
    const baseUrl = model.baseUrl.trim();
    if (baseUrl && !baseUrl.includes("{location}")) {
      httpOptions.baseUrl = baseUrl;
      httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
      const url = URL.parse(baseUrl);
      if (
        url
          ? url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part))
          : /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl)
      ) {
        httpOptions.apiVersion = "";
      }
    }
  } else if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes the version path.
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels(
      profile === "vertex"
        ? { ...model.headers, ...optionsHeaders }
        : mergeTransportHeaders(model.headers, optionsHeaders),
    );
  }
  return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}
