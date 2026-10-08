import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import { resolveOllamaApiBase } from "./provider-models.js";

const loadOllamaUsage = createLazyRuntimeModule(() => import("./usage.js"));

export function createOllamaUsageHooks(): Pick<
  ProviderPlugin,
  "resolveUsageAuth" | "fetchUsageSnapshot"
> {
  return {
    resolveUsageAuth: (ctx) => {
      const token = ctx.resolveApiKeyFromConfigAndStore();
      return token ? { token } : null;
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
