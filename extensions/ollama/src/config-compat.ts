import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  type PluginDoctorProviderRename,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { OLLAMA_DEFAULT_API_KEY } from "./defaults.js";

const OLLAMA_PROVIDER_ID = "ollama";
const LEGACY_OLLAMA_API_KEY_MARKER = "OLLAMA_API_KEY";
const LEGACY_OLLAMA_PROFILE_ID = "ollama:default";

export const providerRenames: readonly PluginDoctorProviderRename[] = [
  { from: OLLAMA_PROVIDER_ID, to: "ollama-cloud", baseUrl: "https://ollama.com" },
];

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown, root?: Record<string, unknown>) => boolean;
};

function isLegacyOllamaLocalConfig(provider: unknown, root?: Record<string, unknown>): boolean {
  const providerRecord = asObjectRecord(provider);
  const baseUrl = providerRecord?.baseUrl;
  if (typeof baseUrl === "string") {
    if (baseUrl.includes("${")) {
      return false;
    }
    try {
      if (new URL(baseUrl).origin === "https://ollama.com") {
        return false;
      }
    } catch {
      // An invalid endpoint is handled by config validation.
    }
  }
  const auth = asObjectRecord(root?.auth);
  const profiles = asObjectRecord(auth?.profiles);
  const profile = asObjectRecord(profiles?.[LEGACY_OLLAMA_PROFILE_ID]);
  return (
    providerRecord?.api === "ollama" &&
    providerRecord.apiKey === LEGACY_OLLAMA_API_KEY_MARKER &&
    profile?.provider === OLLAMA_PROVIDER_ID &&
    profile.mode === "api_key" &&
    Object.keys(profile).length === 2
  );
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["models", "providers", OLLAMA_PROVIDER_ID],
    message:
      'Legacy local Ollama authentication markers must be migrated. Run "openclaw doctor --fix".',
    match: isLegacyOllamaLocalConfig,
  },
];

function migrateLegacyOllamaLocalConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.[OLLAMA_PROVIDER_ID];
  if (!isLegacyOllamaLocalConfig(provider, { ...config })) {
    return null;
  }

  const nextConfig = structuredClone(config);
  const nextModels = asObjectRecord(nextConfig.models) ?? {};
  nextConfig.models = nextModels as OpenClawConfig["models"];
  const nextProviders = asObjectRecord(nextModels.providers) ?? {};
  nextModels.providers = nextProviders;
  const nextProvider = asObjectRecord(nextProviders[OLLAMA_PROVIDER_ID]) ?? {};
  nextProviders[OLLAMA_PROVIDER_ID] = nextProvider;
  nextProvider.apiKey = OLLAMA_DEFAULT_API_KEY;
  const nextAuth = asObjectRecord(nextConfig.auth);
  const nextProfiles = asObjectRecord(nextAuth?.profiles);
  if (nextAuth && nextProfiles) {
    delete nextProfiles[LEGACY_OLLAMA_PROFILE_ID];
    if (Object.keys(nextProfiles).length === 0) {
      delete nextAuth.profiles;
    }
    if (Object.keys(nextAuth).length === 0) {
      delete nextConfig.auth;
    }
  }
  return {
    config: nextConfig,
    changes: [
      `Migrated models.providers.${OLLAMA_PROVIDER_ID}.apiKey to ${OLLAMA_DEFAULT_API_KEY} and removed the obsolete ${LEGACY_OLLAMA_PROFILE_ID} auth profile marker.`,
    ],
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return migrateLegacyOllamaLocalConfig(cfg) ?? { config: cfg, changes: [] };
}
