import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { formatCliCommand } from "../cli/command-format.js";
import {
  projectModelProviderConfig,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { resolveProviderAuthAliasMap, resolveProviderIdForAuth } from "./provider-auth-aliases.js";

function normalizeProviderIdForAuth(
  providerId: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeProviderId(providerId);
  return normalized ? (aliases[normalized] ?? normalized) : normalized;
}

/** Missing credentials on a declared OAuth-only native route need login, not a pasted key. */
export function resolveProviderOAuthLoginCommand(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  modelBaseUrl?: string;
}): string | undefined {
  const config = params.modelBaseUrl
    ? projectModelProviderConfig(params.config, params.provider, { baseUrl: params.modelBaseUrl })
    : params.config;
  const providerConfig = resolveMergedModelProviderConfig(config, params.provider);
  if (providerConfig?.auth && providerConfig.auth !== "oauth") {
    return undefined;
  }
  const metadataSnapshot = loadManifestMetadataSnapshot({ ...params, config });
  const lookup = { ...params, config, metadataSnapshot };
  const provider = resolveProviderIdForAuth(params.provider, lookup);
  const choices = resolveManifestDeclaredProviderAuthChoices(lookup).filter(
    (choice) => resolveProviderIdForAuth(choice.providerId, lookup) === provider,
  );
  const choice = choices[0];
  if (
    !choice ||
    choices.some(
      (candidate) =>
        !candidate.appGuidedAuth ||
        candidate.appGuidedSecret ||
        candidate.pluginId !== choice.pluginId,
    )
  ) {
    return undefined;
  }
  const plugin = metadataSnapshot.byPluginId.get(choice.pluginId);
  // Catalog compatibility is permissive for undeclared adapters. Require native
  // endpoint evidence before turning an inline provider's API-key hint into login.
  if (
    !plugin ||
    (!findNormalizedProviderValue(plugin.modelCatalog?.providers, provider)?.baseUrl &&
      !plugin.providerEndpoints?.length)
  ) {
    return undefined;
  }
  const endpointConfig = providerConfig
    ? projectModelProviderConfig(config, provider, { baseUrl: providerConfig.baseUrl })
    : config;
  if (!isProviderCatalogSourceAllowed({ provider, config: endpointConfig, plugin })) {
    return undefined;
  }
  return formatCliCommand(`openclaw models auth login --provider ${provider}`);
}

export function buildProviderAuthRecoveryHint(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeEnvVar?: boolean;
}): string {
  const aliases = resolveProviderAuthAliasMap(params);
  const normalized = normalizeProviderIdForAuth(params.provider, aliases);
  const choice = resolveManifestProviderAuthChoices(params).find(
    (candidate) =>
      normalized && normalizeProviderIdForAuth(candidate.providerId, aliases) === normalized,
  );
  const loginCommand = choice
    ? formatCliCommand(`openclaw models auth login --provider ${normalized}`)
    : undefined;
  const parts: string[] = [];
  if (loginCommand) {
    parts.push(`Run \`${loginCommand}\``);
  }
  parts.push(`\`${formatCliCommand("openclaw configure")}\``);
  if (params.includeEnvVar) {
    parts.push("set an API key env var");
  }
  if (parts.length === 1) {
    return `${parts[0]}.`;
  }
  if (parts.length === 2) {
    return `${parts[0]} or ${parts[1]}.`;
  }
  return `${parts[0]}, ${parts[1]}, or ${parts[2]}.`;
}
