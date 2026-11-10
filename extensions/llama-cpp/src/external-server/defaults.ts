// llama-server's default port since llama.cpp b11521 (ggml-org/llama.cpp#30159); older
// builds listen on 8080, so setup accepts that endpoint when entered explicitly.
export const LLAMA_SERVER_DEFAULT_ORIGIN = "http://127.0.0.1:9931";
export const LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR = "LLAMA_SERVER_API_KEY";
export const LLAMA_SERVER_DISCOVERY_TIMEOUT_MS = 5_000;
