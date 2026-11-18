import type { ProviderNativeWebSearchPolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { isOpenAIApiBaseUrl } from "./base-url.js";

/** Shared by catalog selection and payload construction before any provider request. */
export function resolveNativeWebSearch(ctx: ProviderNativeWebSearchPolicyContext): boolean {
  const provider = ctx.config?.tools?.web?.search?.provider?.trim().toLowerCase();
  return (
    ctx.config?.tools?.web?.search?.enabled !== false &&
    (!provider || provider === "auto" || provider === "openai") &&
    ctx.api === "openai-responses" &&
    ctx.provider.trim().toLowerCase() === "openai" &&
    (!ctx.baseUrl || isOpenAIApiBaseUrl(ctx.baseUrl))
  );
}
