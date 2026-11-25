import { GoogleGenAI } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { buildGoogleHttpOptions } from "./google-http-options.js";
import { createGoogleGenerateContentStreams } from "./google-provider-stream.js";

export const { stream: streamGoogle, streamSimple: streamSimpleGoogle } =
  createGoogleGenerateContentStreams(
    "google-generative-ai",
    (model, options) => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const optionsHeaders = resolveOpencodeSessionHeaders(model, options);
      const httpOptions = buildGoogleHttpOptions(model, optionsHeaders, "generative-ai");

      // Authentication is resolved before construction; the SDK also retains the host fetch policy.
      const resolvedApiKey = apiKey
        ? getAiTransportHost().resolveSecretSentinel(apiKey)
        : undefined;
      return new GoogleGenAI({
        apiKey: resolvedApiKey,
        httpOptions,
      });
    },
    (model, options) => requireApiKey(model.provider, options?.apiKey),
  );
