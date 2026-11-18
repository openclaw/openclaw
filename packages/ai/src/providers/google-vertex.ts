import { GoogleGenAI } from "@google/genai";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost } from "../host.js";
import type { Model, StreamFunction } from "../types.js";
import { buildGoogleHttpOptions } from "./google-http-options.js";
import { createGoogleGenerateContentStreams } from "./google-provider-stream.js";
import type { GoogleProviderOptions } from "./google-shared.js";

interface GoogleVertexOptions extends GoogleProviderOptions {
  project?: string;
  location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const streams = createGoogleGenerateContentStreams("google-vertex", createClient);
export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> =
  streams.stream;
export const streamSimpleGoogleVertex = streams.streamSimple;

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
    httpOptions: buildGoogleHttpOptions(model, options?.headers, "vertex"),
  });
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
