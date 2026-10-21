import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExternalCliAuthScopeFromConfig } from "./external-cli-scope.js";

export type ExternalCliAuthDiscovery =
  | {
      mode: "none";
      allowKeychainPrompt?: false;
      config?: OpenClawConfig;
    }
  | {
      mode: "existing";
      allowKeychainPrompt?: boolean;
      config?: OpenClawConfig;
    }
  | {
      mode: "scoped";
      allowKeychainPrompt?: boolean;
      config?: OpenClawConfig;
      providerIds?: Iterable<string>;
      profileIds?: Iterable<string>;
    };

function externalCliDiscoveryNone(params?: { config?: OpenClawConfig }): ExternalCliAuthDiscovery {
  return {
    mode: "none",
    allowKeychainPrompt: false,
    ...(params?.config ? { config: params.config } : {}),
  };
}

export function externalCliDiscoveryScoped(
  params: Omit<Extract<ExternalCliAuthDiscovery, { mode: "scoped" }>, "mode">,
): ExternalCliAuthDiscovery {
  return {
    mode: "scoped",
    ...(params.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: params.allowKeychainPrompt }
      : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.providerIds ? { providerIds: params.providerIds } : {}),
    ...(params.profileIds ? { profileIds: params.profileIds } : {}),
  };
}

export function externalCliDiscoveryForProviderAuth(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId?: string;
  preferredProfile?: string;
  allowKeychainPrompt?: boolean;
}): ExternalCliAuthDiscovery {
  const profileIds = normalizeTrimmedStringList([params.profileId, params.preferredProfile]);
  return externalCliDiscoveryScoped({
    config: params.cfg,
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
    providerIds: [params.provider],
    ...(profileIds.length > 0 ? { profileIds } : {}),
  });
}

export function externalCliDiscoveryForConfigStatus(params: {
  cfg: OpenClawConfig;
  allowKeychainPrompt?: false;
}): ExternalCliAuthDiscovery {
  const scope = resolveExternalCliAuthScopeFromConfig(params.cfg);
  return scope
    ? externalCliDiscoveryScoped({
        config: params.cfg,
        allowKeychainPrompt: params.allowKeychainPrompt ?? false,
        providerIds: scope.providerIds,
        profileIds: scope.profileIds,
      })
    : externalCliDiscoveryNone({ config: params.cfg });
}

export function externalCliDiscoveryForProviders(params: {
  cfg?: OpenClawConfig;
  providers: Iterable<string>;
  allowKeychainPrompt?: false;
}): ExternalCliAuthDiscovery {
  const providers = normalizeTrimmedStringList([...params.providers]);
  if (providers.length === 0) {
    return externalCliDiscoveryNone({ config: params.cfg });
  }
  return externalCliDiscoveryScoped({
    config: params.cfg,
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
    providerIds: providers,
  });
}
