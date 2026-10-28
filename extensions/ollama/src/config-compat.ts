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

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const provider = cfg.models?.providers?.[OLLAMA_PROVIDER_ID];
  if (!provider || !isLegacyOllamaLocalConfig(provider, cfg)) {
    return { config: cfg, changes: [] };
  }

  const profiles = { ...cfg.auth?.profiles };
  delete profiles[LEGACY_OLLAMA_PROFILE_ID];
  const auth = { ...cfg.auth };
  if (Object.keys(profiles).length > 0) {
    auth.profiles = profiles;
  } else {
    delete auth.profiles;
  }
  const config: OpenClawConfig = {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [OLLAMA_PROVIDER_ID]: { ...provider, apiKey: OLLAMA_DEFAULT_API_KEY },
      },
    },
    auth,
  };
  if (Object.keys(auth).length === 0) {
    delete config.auth;
  }
  return {
    config,
    changes: [
      `Migrated models.providers.${OLLAMA_PROVIDER_ID}.apiKey to ${OLLAMA_DEFAULT_API_KEY} and removed the obsolete ${LEGACY_OLLAMA_PROFILE_ID} auth profile marker.`,
    ],
  };
}
