/**
 * OCI Generative AI native embeddings.
 *
 * OCI does not expose embeddings on the OpenAI-compat path; the catalog
 * lives only on the native endpoint:
 *
 *   POST https://inference.generativeai.<region>.oci.oraclecloud.com
 *        /20231130/actions/embedText
 *
 *   {
 *     "compartmentId": "<ocid>",
 *     "servingMode":   { "modelId": "cohere.embed-multilingual-v3.0",
 *                        "servingType": "ON_DEMAND" },
 *     "inputs":        ["text1", "text2"],
 *     "inputType":     "SEARCH_QUERY" | "SEARCH_DOCUMENT",
 *     "truncate":      "END"
 *   }
 *
 * Models served:
 *   cohere.embed-english-v3.0          (1024 dims)
 *   cohere.embed-multilingual-v3.0     (1024 dims)
 *   cohere.embed-english-light-v3.0    (384  dims)
 *   cohere.embed-multilingual-light-v3.0 (384 dims)
 */

import {
  debugEmbeddingsLog,
  sanitizeAndNormalizeEmbedding,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { createOciSignedFetch, OciRequestSigner } from "./oci-signer.js";
import {
  defaultOciConfigPath,
  loadOciProfile,
  OciConfigError,
  type OciProfile,
} from "./profile-loader.js";
import {
  buildOciGenAINativeBaseUrl,
  DEFAULT_OCI_GENAI_REGION,
  isOciRegion,
  type OciRegion,
} from "./regions.js";

export const DEFAULT_OCI_EMBEDDING_MODEL = "cohere.embed-multilingual-v3.0";

type EmbeddingFamily = "cohere-v3";

interface EmbeddingSpec {
  readonly family: EmbeddingFamily;
  readonly maxTokens: number;
  readonly dims: number;
}

const EMBEDDING_MODELS: Record<string, EmbeddingSpec> = {
  "cohere.embed-english-v3.0": { family: "cohere-v3", maxTokens: 512, dims: 1024 },
  "cohere.embed-multilingual-v3.0": { family: "cohere-v3", maxTokens: 512, dims: 1024 },
  "cohere.embed-english-light-v3.0": { family: "cohere-v3", maxTokens: 512, dims: 384 },
  "cohere.embed-multilingual-light-v3.0": { family: "cohere-v3", maxTokens: 512, dims: 384 },
};

const MODEL_PREFIX_RE = /^(?:oci|oci-genai|oraclecloud)\//;

function normalizeOciEmbeddingModel(model: string): string {
  const trimmed = model.trim();
  return trimmed ? trimmed.replace(MODEL_PREFIX_RE, "") : DEFAULT_OCI_EMBEDDING_MODEL;
}

function resolveSpec(modelId: string): EmbeddingSpec | undefined {
  return EMBEDDING_MODELS[modelId];
}

type OciPluginConfigSlice = {
  readonly region?: string;
  readonly compartmentId?: string;
  readonly profileName?: string;
  readonly configFile?: string;
  readonly authType?: "api_key" | "instance_principal" | "resource_principal";
};

export type OciEmbeddingClient = {
  readonly region: OciRegion;
  readonly compartmentId: string;
  readonly model: string;
  readonly profile: OciProfile;
};

const OCI_PLUGIN_ID = "oci-genai";

function readOciPluginConfig(options: MemoryEmbeddingProviderCreateOptions): OciPluginConfigSlice {
  const slice = resolvePluginConfigObject(options.config, OCI_PLUGIN_ID);
  return (slice ?? {}) as OciPluginConfigSlice;
}

function resolveRegion(
  options: MemoryEmbeddingProviderCreateOptions,
  pluginConfig: OciPluginConfigSlice,
): OciRegion {
  const candidate =
    pluginConfig.region?.trim() ||
    process.env.OCI_REGION?.trim() ||
    process.env.OCI_GENAI_REGION?.trim() ||
    DEFAULT_OCI_GENAI_REGION;
  if (!isOciRegion(candidate)) {
    throw new Error(
      `OCI Generative AI region "${candidate}" is not supported. ` +
        "Set agents-config plugins.oci-genai.region or OCI_REGION to one of the supported regions.",
    );
  }
  // Soft sanity: ensure the configured baseUrl (if any) targets the same region.
  const baseUrl = options.remote?.baseUrl;
  if (baseUrl && !baseUrl.includes(candidate)) {
    debugEmbeddingsLog("oci embeddings: region/baseUrl mismatch", {
      configuredRegion: candidate,
      baseUrl,
    });
  }
  return candidate;
}

async function resolveProfile(pluginConfig: OciPluginConfigSlice): Promise<OciProfile> {
  const authType = pluginConfig.authType ?? "api_key";
  if (authType !== "api_key") {
    throw new Error(
      `OCI auth type "${authType}" is not yet wired for embeddings. ` +
        "Use api_key (RSA-signed via ~/.oci/config) until workload-identity flow lands.",
    );
  }
  const configFile =
    pluginConfig.configFile?.trim() ||
    process.env.OCI_CONFIG_FILE?.trim() ||
    defaultOciConfigPath();
  const profileName =
    pluginConfig.profileName?.trim() || process.env.OCI_PROFILE?.trim() || "DEFAULT";
  try {
    return await loadOciProfile({ configFile, profileName });
  } catch (err) {
    if (err instanceof OciConfigError) {
      throw new Error(
        `No API key found for provider "oci": ${err.message}. ` +
          "Run `openclaw configure` to set up OCI, or populate ~/.oci/config with a valid profile.",
        { cause: err },
      );
    }
    throw err;
  }
}

function resolveCompartmentId(pluginConfig: OciPluginConfigSlice, profile: OciProfile): string {
  return (
    pluginConfig.compartmentId?.trim() ||
    process.env.OCI_COMPARTMENT_ID?.trim() ||
    profile.tenancy.trim() ||
    ""
  );
}

export type CreateOciEmbeddingProviderOptions = MemoryEmbeddingProviderCreateOptions & {
  /** Override fetch (tests). Production callers leave this unset. */
  readonly fetchImpl?: typeof fetch;
};

export async function createOciEmbeddingProvider(
  options: CreateOciEmbeddingProviderOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: OciEmbeddingClient }> {
  const pluginConfig = readOciPluginConfig(options);
  const region = resolveRegion(options, pluginConfig);
  const profile = await resolveProfile(pluginConfig);
  const compartmentId = resolveCompartmentId(pluginConfig, profile);
  if (!compartmentId) {
    throw new Error(
      "OCI Generative AI embeddings require a compartmentId. " +
        "Set plugins.oci-genai.compartmentId, OCI_COMPARTMENT_ID, or use a profile with a tenancy OCID.",
    );
  }
  const model = normalizeOciEmbeddingModel(options.model);
  const spec = resolveSpec(model);
  const dims = spec?.dims;

  debugEmbeddingsLog("memory embeddings: oci client", {
    region,
    model,
    dimensions: dims,
    family: spec?.family ?? "cohere-v3",
  });

  const signer = new OciRequestSigner({ profile });
  const signedFetch = createOciSignedFetch(signer, options.fetchImpl ?? fetch);
  const url = `${buildOciGenAINativeBaseUrl(region)}/actions/embedText`;

  async function embed(
    inputs: readonly string[],
    inputType: "SEARCH_QUERY" | "SEARCH_DOCUMENT",
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const body = JSON.stringify({
      compartmentId,
      servingMode: { modelId: model, servingType: "ON_DEMAND" },
      inputs,
      inputType,
      truncate: "END",
    });
    const response = await signedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OCI embeddings failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      );
    }
    const json = (await response.json()) as { embeddings?: number[][] };
    return (json.embeddings ?? []).map((vec) => sanitizeAndNormalizeEmbedding(vec));
  }

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const [vec] = await embed([text], "SEARCH_QUERY");
    return vec ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    const filtered = texts.map((t) => (t.trim() ? t : ""));
    const nonEmptyIdx: number[] = [];
    const nonEmptyTexts: string[] = [];
    filtered.forEach((t, i) => {
      if (t) {
        nonEmptyIdx.push(i);
        nonEmptyTexts.push(t);
      }
    });
    if (nonEmptyTexts.length === 0) {
      return texts.map(() => [] as number[]);
    }
    const vecs = await embed(nonEmptyTexts, "SEARCH_DOCUMENT");
    const out: number[][] = texts.map(() => []);
    nonEmptyIdx.forEach((origIdx, i) => {
      out[origIdx] = vecs[i] ?? [];
    });
    return out;
  };

  return {
    provider: {
      id: "oci",
      model,
      maxInputTokens: spec?.maxTokens,
      embedQuery,
      embedBatch,
    },
    client: { region, compartmentId, model, profile },
  };
}

/** Whether the host has enough OCI credentials to attempt embeddings. */
export async function hasOciCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loadProfile: (params: {
    configFile: string;
    profileName: string;
  }) => Promise<OciProfile> = loadOciProfile,
): Promise<boolean> {
  const configFile = env.OCI_CONFIG_FILE?.trim() || defaultOciConfigPath();
  const profileName = env.OCI_PROFILE?.trim() || "DEFAULT";
  try {
    await loadProfile({ configFile, profileName });
    return true;
  } catch {
    return false;
  }
}
