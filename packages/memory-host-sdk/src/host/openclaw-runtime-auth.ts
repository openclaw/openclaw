import type { resolveApiKeyForProviderCore as ResolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";
export { requireApiKey } from "../../../../src/agents/model-auth-runtime-shared.js";

// Lazy auth facade so memory host helpers avoid eager model-auth module loading.

/** Resolve a provider API key through the core model-auth runtime. */
export const resolveApiKeyForProvider: typeof ResolveApiKeyForProvider = async (...args) => {
  const auth = await import("../../../../src/agents/model-auth.js");
  return auth.resolveApiKeyForProviderCore(...args);
};
