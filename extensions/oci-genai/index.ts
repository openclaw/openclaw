/**
 * OCI Generative AI provider plugin entry.
 *
 * Two transport paths share one provider registration:
 *
 *   1. OpenAI-compat (`/openai/v1/chat/completions`) — the default for
 *      the openai-completions transport. The catalog binds here.
 *   2. Native (`/20231130/actions/chat` + `/actions/embedText`) — used
 *      for Cohere features and OCI embeddings. Surface lives in
 *      `OciNativeClient`, `createOciSignedFetch`, and the memory
 *      embedding adapter.
 */

import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { ociMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { applyOciConfig, OCI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildOciProvider } from "./provider-catalog.js";

const PROVIDER_ID = "oci";

export {
  loadOciProfile,
  defaultOciConfigPath,
  OciConfigError,
  type OciProfile,
} from "./profile-loader.js";
export {
  OciRequestSigner,
  OciSignerError,
  createOciSignedFetch,
  type SignableRequest,
  type SignedHeaders,
} from "./oci-signer.js";
export {
  OCI_GENAI_REGIONS,
  DEFAULT_OCI_GENAI_REGION,
  buildOciGenAIHost,
  buildOciGenAINativeBaseUrl,
  buildOciGenAIOpenAIBaseUrl,
  type OciRegion,
} from "./regions.js";
export {
  OCI_GENAI_MODELS,
  findOciGenAIModel,
  type OciGenAIModelEntry,
  type OciGenAIModelId,
} from "./models.js";
export {
  OciNativeClient,
  OciNativeError,
  type OciNativeChatRequest,
  type OciNativeChatResponse,
  type OciNativeApiFormat,
} from "./native-client.js";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OCI Generative AI Provider",
  description:
    "Bundled Oracle Cloud Infrastructure Generative AI provider plugin. " +
    "Routes chat completions through OCI's OpenAI-compatible endpoint and " +
    "exposes the native chat/embedText surface for Cohere features.",
  provider: {
    label: "Oracle Cloud Infrastructure GenAI",
    docsPath: "/providers/oci",
    auth: [
      {
        methodId: "api-key",
        label: "OCI API key (~/.oci/config profile)",
        hint: "RSA-signed requests via OCI config profile",
        optionKey: "ociProfileName",
        flagName: "--oci-profile",
        envVar: "OCI_PROFILE",
        promptMessage: "Enter the OCI profile name (default: DEFAULT)",
        defaultModel: OCI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyOciConfig(cfg),
        noteMessage: [
          "OCI Generative AI authenticates with RSA request signing.",
          "Provide a profile name from ~/.oci/config (e.g. DEFAULT, API_FREE_TIER).",
          "Free Tier models live in us-chicago-1; pricing at",
          "https://www.oracle.com/cloud/generative-ai/pricing/",
        ].join("\n"),
        noteTitle: "Oracle Cloud Infrastructure",
        wizard: {
          groupLabel: "Oracle Cloud Infrastructure",
          groupHint: "OpenAI-compatible chat + native Cohere/embedText surface",
        },
      },
    ],
    catalog: {
      buildProvider: () => buildOciProvider(),
      buildStaticProvider: () => buildOciProvider(),
    },
  },
  register(api) {
    api.registerMemoryEmbeddingProvider(ociMemoryEmbeddingProviderAdapter);
  },
});
