import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

export function createLegacyGeminiEmbeddingProvider(apiKey = "test-key") {
  return createGeminiEmbeddingProvider({
    config: {},
    provider: "gemini",
    remote: { apiKey },
    model: "gemini-embedding-001",
    fallback: "none",
  });
}

export function createGeminiRetryInfoPayload(retryDelay: string) {
  return {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay,
        },
      ],
    },
  };
}
