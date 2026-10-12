import { collectConfiguredModelRefValues } from "@openclaw/model-catalog-core/configured-model-refs";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { OLLAMA_DEFAULT_API_KEY, OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { isLocalOllamaBaseUrl, readOllamaStringValue } from "./discovery-shared.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import { resolveOllamaApiBase } from "./provider-models.js";

const loadOllamaUsage = createLazyRuntimeModule(() => import("./usage.js"));

export function createOllamaUsageHooks(): Pick<
  ProviderPlugin,
  "resolveUsageAuth" | "fetchUsageSnapshot"
> {
  return {
    resolveUsageAuth: async (ctx) => {
      const provider = ctx.config.models?.providers?.ollama;
      if (
        !provider &&
        ctx.env.OLLAMA_API_KEY?.trim() !== OLLAMA_DEFAULT_API_KEY &&
        !collectConfiguredModelRefValues(ctx.config).some((ref) =>
          ref.toLowerCase().startsWith("ollama/"),
        )
      ) {
        // Hosted credentials alone do not opt into the daemon's separate account.
        return { handled: true };
      }
      const baseUrl = readProviderBaseUrl(provider) ?? OLLAMA_DEFAULT_BASE_URL;
      if (!isLocalOllamaBaseUrl(baseUrl)) {
        const token = ctx.resolveApiKeyFromConfigAndStore();
        return token ? { token } : { handled: true };
      }

      // The shared resolver prefers ambient OLLAMA_API_KEY over the configured
      // local marker. Resolve only this endpoint's explicit input for LAN URLs.
      const input = provider?.apiKey;
      if (input === undefined || input === null) {
        return { token: OLLAMA_DEFAULT_API_KEY };
      }
      const resolved = await resolveConfiguredSecretInputString({
        config: ctx.config,
        env: ctx.env,
        value: input,
        path: "models.providers.ollama.apiKey",
        unresolvedReasonStyle: "detailed",
      });
      if (resolved.unresolvedRefReason) {
        return { handled: true };
      }
      const value = readOllamaStringValue(resolved.value);
      const token = value === "OLLAMA_API_KEY" ? ctx.env.OLLAMA_API_KEY?.trim() : value;
      return token ? { token } : { handled: true };
    },
    fetchUsageSnapshot: async (ctx) =>
      await (
        await loadOllamaUsage()
      ).fetchOllamaUsage({
        baseUrl: resolveOllamaApiBase(
          readProviderBaseUrl(ctx.config.models?.providers?.ollama) ?? OLLAMA_DEFAULT_BASE_URL,
        ),
        token: ctx.token,
        timeoutMs: ctx.timeoutMs,
        fetchFn: ctx.fetchFn,
      }),
  };
}
