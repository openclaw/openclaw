import {
  LLAMA_CPP_LOCAL_AUTH_MARKER,
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
} from "../defaults.js";

// llama-server's default port since llama.cpp b11521 (ggml-org/llama.cpp#30159); older
// builds listen on 8080, so setup accepts that endpoint when entered explicitly.
export const LLAMA_SERVER_DEFAULT_ORIGIN = "http://127.0.0.1:9931";
const LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR = "LLAMA_SERVER_API_KEY";
export const LLAMA_SERVER_DISCOVERY_TIMEOUT_MS = 5_000;

/** One external-server owner, with independent endpoint and credential namespaces. */
export type LlamaServerIdentity = {
  id: string;
  label: string;
  defaultOrigin: string;
  apiKeyEnvVar: string;
  authMarker: string;
};

export const LLAMA_CPP_SERVER: LlamaServerIdentity = {
  id: LLAMA_CPP_PROVIDER_ID,
  label: LLAMA_CPP_PROVIDER_LABEL,
  defaultOrigin: LLAMA_SERVER_DEFAULT_ORIGIN,
  apiKeyEnvVar: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  authMarker: LLAMA_CPP_LOCAL_AUTH_MARKER,
};

export const LLAMA_APP_SERVER: LlamaServerIdentity = {
  id: "llama-app",
  label: "Llama",
  defaultOrigin: "http://127.0.0.1:9931",
  apiKeyEnvVar: "LLAMA_APP_API_KEY",
  authMarker: "llama-app-local",
};
