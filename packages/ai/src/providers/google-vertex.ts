import { GoogleGenAI, type HttpOptions, ResourceScope } from "@google/genai";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { buildManagedModelFetch } from "../transports/host-policy.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  type GoogleProviderOptions,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

interface GoogleVertexOptions extends GoogleProviderOptions {
  project?: string;
  location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

let toolCallCounter = 0;

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: GoogleVertexOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantOutput(model, "google-vertex");

  void runGoogleGenerateContentLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => createClient(model, options),
    buildParams: () => buildGoogleGenerateContentParams(model, context, options),
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const base = buildBaseOptions(model, options, undefined);
  return streamGoogleVertex(model, context, {
    ...base,
    thinking: buildGoogleSimpleThinking(model, options),
  } satisfies GoogleVertexOptions);
};

function createClient(model: Model<"google-vertex">, options?: GoogleVertexOptions): GoogleGenAI {
  const apiKey = resolveApiKey(options);
  // Authentication is resolved before construction; the SDK also retains the host fetch policy.
  const credentials = apiKey
    ? { apiKey: getAiTransportHost().resolveSecretSentinel(apiKey) }
    : { project: resolveProject(options), location: resolveLocation(options) };
  return new GoogleGenAI({
    vertexai: true,
    ...credentials,
    apiVersion: API_VERSION,
    httpOptions: buildHttpOptions(model, options?.headers),
  });
}

function buildHttpOptions(
  model: Model<"google-vertex">,
  optionsHeaders?: Record<string, string>,
): HttpOptions | undefined {
  const httpOptions: HttpOptions = {};
  const fetcher = buildManagedModelFetch(model);
  if (fetcher) {
    httpOptions.fetch = fetcher;
  }
  const baseUrl = resolveCustomBaseUrl(model.baseUrl);
  if (baseUrl) {
    httpOptions.baseUrl = baseUrl;
    httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
    if (baseUrlIncludesApiVersion(baseUrl)) {
      httpOptions.apiVersion = "";
    }
  }

  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels({
      ...model.headers,
      ...optionsHeaders,
    });
  }

  return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed.includes("{location}")) {
    return undefined;
  }
  return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
  } catch {
    return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
  }
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
  const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
  if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || /^<[^>]+>$/.test(apiKey)) {
    return undefined;
  }
  return apiKey;
}

function resolveProject(options?: GoogleVertexOptions): string {
  const project =
    normalizeOptionalString(options?.project) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
  const location =
    normalizeOptionalString(options?.location) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}
