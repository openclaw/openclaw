import { ensureRecord } from "openclaw/plugin-sdk/collection-input-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";
import { mergeMissing } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asNullableRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BEDROCK_AWS_SDK_PROFILE_ID, BEDROCK_PROVIDER_ID } from "./aws-sdk-profile.js";

type JsonRecord = Record<string, unknown>;

const LEGACY_PATH = "models.bedrockDiscovery";
const TARGET_PATH = "plugins.entries.amazon-bedrock.config.discovery";
const PROVIDER_AUTH_PATH = `models.providers.${BEDROCK_PROVIDER_ID}.auth`;
const PROFILE_PATH = `auth.profiles.${BEDROCK_AWS_SDK_PROFILE_ID}`;

function resolveLegacyBedrockDiscoveryConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const models = asNullableRecord(raw.models);
  return asNullableRecord(models?.bedrockDiscovery) ?? undefined;
}

function pruneEmptyModelsRoot(root: JsonRecord): void {
  const models = asNullableRecord(root.models);
  if (models && Object.keys(models).length === 0) {
    delete root.models;
  }
}

function migrateLegacyDiscoveryConfig(raw: JsonRecord): {
  config: JsonRecord;
  changes: string[];
} {
  const legacy = resolveLegacyBedrockDiscoveryConfig(raw);
  if (!legacy) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw) as JsonRecord;
  const models = ensureRecord(nextRoot, "models");
  delete models.bedrockDiscovery;
  pruneEmptyModelsRoot(nextRoot);

  const changes: string[] = [];
  if (Object.keys(legacy).length === 0) {
    changes.push(`Removed empty ${LEGACY_PATH}.`);
    return { config: nextRoot, changes };
  }

  const plugins = ensureRecord(nextRoot, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, "amazon-bedrock");
  const config = ensureRecord(entry, "config");
  const existing = asNullableRecord(config.discovery) ?? undefined;

  if (!existing) {
    config.discovery = { ...legacy };
    changes.push(`Moved ${LEGACY_PATH} → ${TARGET_PATH}.`);
    return { config: nextRoot, changes };
  }

  const merged = { ...existing };
  mergeMissing(merged, legacy);
  config.discovery = merged;
  if (JSON.stringify(merged) !== JSON.stringify(existing)) {
    changes.push(
      `Merged ${LEGACY_PATH} → ${TARGET_PATH} (filled missing fields from legacy; kept explicit plugin config values).`,
    );
    return { config: nextRoot, changes };
  }

  changes.push(`Removed ${LEGACY_PATH} (${TARGET_PATH} already set).`);
  return { config: nextRoot, changes };
}

function hasDeclaredAwsSdkProfile(raw: JsonRecord): boolean {
  const profiles = asNullableRecord(asNullableRecord(raw.auth)?.profiles);
  return Object.values(profiles ?? {}).some((value) => {
    const profile = asNullableRecord(value);
    return (
      profile?.mode === "aws-sdk" &&
      typeof profile.provider === "string" &&
      normalizeProviderId(profile.provider) === BEDROCK_PROVIDER_ID
    );
  });
}

/**
 * Configs written before auth profiles covered Bedrock authenticate through
 * `auth: "aws-sdk"` alone, which leaves scheduled runs with no account to
 * record. Declaring the AWS SDK profile names that route without storing a
 * credential; interactive runs keep resolving the same default chain.
 */
function declareAwsSdkAuthProfile(raw: JsonRecord): { config: JsonRecord; changes: string[] } {
  const providers = asNullableRecord(asNullableRecord(raw.models)?.providers);
  const provider = Object.entries(providers ?? {}).find(
    ([providerId]) => normalizeProviderId(providerId) === BEDROCK_PROVIDER_ID,
  );
  if (asNullableRecord(provider?.[1])?.auth !== "aws-sdk" || hasDeclaredAwsSdkProfile(raw)) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw) as JsonRecord;
  const profiles = ensureRecord(ensureRecord(nextRoot, "auth"), "profiles");
  profiles[BEDROCK_AWS_SDK_PROFILE_ID] = { provider: BEDROCK_PROVIDER_ID, mode: "aws-sdk" };
  return {
    config: nextRoot,
    changes: [
      `Declared ${PROFILE_PATH} for ${PROVIDER_AUTH_PATH}="aws-sdk" (AWS SDK default credential chain; no credential is stored).`,
    ],
  };
}

export function migrateAmazonBedrockLegacyConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  const discovery = migrateLegacyDiscoveryConfig(raw);
  const profile = declareAwsSdkAuthProfile(discovery.config);
  return {
    config: profile.config as T,
    changes: [...discovery.changes, ...profile.changes],
  };
}
