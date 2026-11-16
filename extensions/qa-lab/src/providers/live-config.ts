import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import JSON5 from "json5";
import { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { discoverConfigSecretTargets, SecretsConfigSchema } from "openclaw/plugin-sdk/qa-runtime";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord,
  isRecord,
  normalizeOptionalString,
  normalizeUniqueStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_LIVE_PROVIDER_CONFIG_PATH_ENV, resolveQaLiveProviderConfigPath } from "./env.js";

function isQaModelProviderConfig(value: unknown): value is ModelProviderConfig {
  return isRecord(value) && typeof value.baseUrl === "string" && Array.isArray(value.models);
}

function normalizeQaLiveProviderConfig(value: unknown): ModelProviderConfig | null {
  if (!isQaModelProviderConfig(value) && (!isRecord(value) || !Object.hasOwn(value, "apiKey"))) {
    return null;
  }
  const { baseUrl: rawBaseUrl, ...providerConfig } = value;
  const baseUrl = normalizeOptionalString(rawBaseUrl);
  return {
    ...providerConfig,
    ...(baseUrl ? { baseUrl } : {}),
    models: Array.isArray(value.models) ? value.models : [],
  } as ModelProviderConfig;
}

export async function readQaLiveProviderConfig(params: {
  providerIds: readonly string[];
}): Promise<{
  providers: Record<string, ModelProviderConfig>;
  secrets?: OpenClawConfig["secrets"];
}> {
  const providerIds = normalizeUniqueStringEntries(params.providerIds);
  if (providerIds.length === 0) {
    return { providers: {} };
  }
  const configPath = resolveQaLiveProviderConfigPath();
  if (!existsSync(configPath.path)) {
    return { providers: {} };
  }
  try {
    const raw = await fs.readFile(configPath.path, "utf8");
    const parsed = JSON5.parse(raw) as unknown;
    const models = asOptionalRecord(asOptionalRecord(parsed)?.models);
    const providers = asOptionalRecord(models?.providers) ?? {};
    const selected: Record<string, ModelProviderConfig> = {};
    for (const providerId of providerIds) {
      const providerConfig = normalizeQaLiveProviderConfig(providers[providerId]);
      if (providerConfig) {
        selected[providerId] = providerConfig;
      }
    }
    const targets = discoverConfigSecretTargets({ models: { providers: selected } });
    if (!targets.some((target) => coerceSecretRef(target.value))) {
      return { providers: selected };
    }
    const secrets = SecretsConfigSchema.parse(asOptionalRecord(parsed)?.secrets);
    if (!secrets) {
      return { providers: selected };
    }
    const refs = targets.flatMap((target) => {
      const ref = coerceSecretRef(target.value, secrets.defaults);
      return ref ? [ref] : [];
    });
    const secretProviders = Object.fromEntries(
      Object.entries(secrets.providers ?? {})
        .filter(([alias, provider]) =>
          refs.some((ref) => ref.provider === alias && ref.source === provider.source),
        )
        .map(([alias, provider]) => [
          alias,
          provider.source === "file"
            ? { ...provider, path: resolveUserPath(provider.path) }
            : provider,
        ]),
    );
    return {
      providers: selected,
      secrets: { ...secrets, providers: secretProviders },
    };
  } catch (error) {
    if (configPath.explicit) {
      throw new Error(
        `failed to read ${QA_LIVE_PROVIDER_CONFIG_PATH_ENV} provider config: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    return { providers: {} };
  }
}
