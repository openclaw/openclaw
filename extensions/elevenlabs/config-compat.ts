import { ensureRecord } from "openclaw/plugin-sdk/collection-input-runtime";
import { mergeMissing } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asNullableRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const LEGACY_TALK_FIELD_KEYS = [
  "voiceId",
  "voiceAliases",
  "modelId",
  "outputFormat",
  "apiKey",
] as const;

type JsonRecord = Record<string, unknown>;

export const ELEVENLABS_TALK_PROVIDER_ID = "elevenlabs";

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

export function hasLegacyTalkFields(value: unknown): value is JsonRecord {
  const talk = asNullableRecord(value);
  if (!talk) {
    return false;
  }
  return LEGACY_TALK_FIELD_KEYS.some((key) => Object.hasOwn(talk, key));
}

function resolveTalkMigrationTargetProviderId(talk: JsonRecord): string | null {
  const explicitProvider =
    typeof talk.provider === "string" && talk.provider.trim() ? talk.provider.trim() : null;
  const providers = asNullableRecord(talk.providers);
  if (explicitProvider) {
    if (isBlockedObjectKey(explicitProvider)) {
      return null;
    }
    return explicitProvider;
  }
  if (!providers) {
    return ELEVENLABS_TALK_PROVIDER_ID;
  }
  const providerIds = Object.keys(providers).filter((key) => !isBlockedObjectKey(key));
  if (providerIds.length === 0) {
    return ELEVENLABS_TALK_PROVIDER_ID;
  }
  if (providerIds.length === 1) {
    return providerIds[0] ?? null;
  }
  return null;
}

export function migrateElevenLabsLegacyTalkConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  const talk = asNullableRecord(raw.talk);
  if (!talk || !hasLegacyTalkFields(talk)) {
    return { config: raw, changes: [] };
  }

  const providerId = resolveTalkMigrationTargetProviderId(talk);
  if (!providerId) {
    return {
      config: raw,
      changes: [
        "Skipped talk legacy field migration because talk.providers defines multiple providers and talk.provider is unset; move talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey under the intended provider manually.",
      ],
    };
  }

  const nextRoot = structuredClone(raw) as JsonRecord;
  const nextTalk = ensureRecord(nextRoot, "talk");
  const providers = ensureRecord(nextTalk, "providers");
  const migratedProvider = asNullableRecord(providers[providerId]) ?? {};
  const legacyFields: JsonRecord = {};
  const movedKeys: string[] = [];

  for (const key of LEGACY_TALK_FIELD_KEYS) {
    if (!Object.hasOwn(nextTalk, key)) {
      continue;
    }
    legacyFields[key] = nextTalk[key];
    delete nextTalk[key];
    movedKeys.push(key);
  }

  mergeMissing(migratedProvider, legacyFields);
  providers[providerId] = migratedProvider;

  return {
    config: nextRoot as T,
    changes: [
      `Moved talk legacy fields (${movedKeys.join(", ")}) → talk.providers.${providerId} (filled missing provider fields only).`,
    ],
  };
}
