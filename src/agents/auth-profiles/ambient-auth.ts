/** Provider auth-pin policy for credentials discovered outside OpenClaw storage. */
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import type { AuthProfileCredential } from "./types.js";

/** Returns whether ambient credential material agrees with a provider's declared auth mode. */
export function isAmbientCredentialAllowedByProviderAuthPin(params: {
  config?: OpenClawConfig;
  authAliasLookupParams?: Omit<ProviderAuthAliasLookupParams, "config">;
  provider: string;
  type: AuthProfileCredential["type"];
}): boolean {
  const providers = params.config?.models?.providers;
  const direct = findNormalizedProviderValue(providers, params.provider);
  const providerAuthKey = resolveProviderIdForAuth(params.provider, {
    config: params.config,
    ...params.authAliasLookupParams,
  });
  const auth = direct?.auth ?? findNormalizedProviderValue(providers, providerAuthKey)?.auth;
  return (
    auth === undefined ||
    (auth === "api-key" && params.type === "api_key") ||
    (auth === "oauth" && (params.type === "oauth" || params.type === "token")) ||
    (auth === "token" && params.type === "token")
  );
}
