import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRecord } from "openclaw/plugin-sdk/collection-input-runtime";
import { mergeMissing } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asNullableRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
const PROFILE_CANDIDATES = [".profile", ".zprofile", ".zshrc", ".bashrc"] as const;
const LEGACY_TALK_FIELD_KEYS = [
  "voiceId",
  "voiceAliases",
  "modelId",
  "outputFormat",
  "apiKey",
] as const;

type JsonRecord = Record<string, unknown>;
type ConfigLocation = [config: JsonRecord, path: string];

export const ELEVENLABS_TALK_PROVIDER_ID = "elevenlabs";

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function* visitElevenLabsTtsProviders(
  value: unknown,
  pathLabel: string,
): Generator<ConfigLocation> {
  const tts = asNullableRecord(value);
  if (!tts) {
    return;
  }
  const provider = asNullableRecord(asNullableRecord(tts.providers)?.elevenlabs);
  if (provider) {
    yield [provider, `${pathLabel}.providers.elevenlabs`];
  }
  for (const [personaId, personaValue] of Object.entries(asNullableRecord(tts.personas) ?? {})) {
    if (isBlockedObjectKey(personaId)) {
      continue;
    }
    const personaProvider = asNullableRecord(
      asNullableRecord(asNullableRecord(personaValue)?.providers)?.elevenlabs,
    );
    if (personaProvider) {
      yield [personaProvider, `${pathLabel}.personas.${personaId}.providers.elevenlabs`];
    }
  }
}

function* visitElevenLabsModelConfigs(raw: JsonRecord): Generator<ConfigLocation> {
  yield* visitElevenLabsTtsProviders(raw.tts, "tts");

  const entries = asNullableRecord(asNullableRecord(raw.agents)?.entries);
  for (const [agentId, entryValue] of Object.entries(entries ?? {})) {
    if (!isBlockedObjectKey(agentId)) {
      yield* visitElevenLabsTtsProviders(
        asNullableRecord(entryValue)?.tts,
        `agents.entries.${agentId}.tts`,
      );
    }
  }

  const channels = asNullableRecord(raw.channels);
  for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
    if (isBlockedObjectKey(channelId)) {
      continue;
    }
    const channel = asNullableRecord(channelValue);
    yield* visitElevenLabsTtsProviders(channel?.tts, `channels.${channelId}.tts`);
    yield* visitElevenLabsTtsProviders(
      asNullableRecord(channel?.voice)?.tts,
      `channels.${channelId}.voice.tts`,
    );
    for (const [accountId, accountValue] of Object.entries(
      asNullableRecord(channel?.accounts) ?? {},
    )) {
      if (isBlockedObjectKey(accountId)) {
        continue;
      }
      const account = asNullableRecord(accountValue);
      yield* visitElevenLabsTtsProviders(
        account?.tts,
        `channels.${channelId}.accounts.${accountId}.tts`,
      );
      yield* visitElevenLabsTtsProviders(
        asNullableRecord(account?.voice)?.tts,
        `channels.${channelId}.accounts.${accountId}.voice.tts`,
      );
    }
  }

  const talkProvider = asNullableRecord(
    asNullableRecord(asNullableRecord(raw.talk)?.providers)?.elevenlabs,
  );
  if (talkProvider) {
    yield [talkProvider, "talk.providers.elevenlabs"];
  }
}

export function hasLegacyElevenLabsModel(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [...visitElevenLabsModelConfigs(value)].some(([config]) => Object.hasOwn(config, "model"));
}

export function migrateElevenLabsModelConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw) || !hasLegacyElevenLabsModel(raw)) {
    return { config: raw, changes: [] };
  }

  // SAFETY: early return above guarantees raw is a plain record.
  const nextRoot = structuredClone(raw) as JsonRecord;
  const changes: string[] = [];
  for (const [config, pathLabel] of visitElevenLabsModelConfigs(nextRoot)) {
    if (!Object.hasOwn(config, "model")) {
      continue;
    }
    const legacyModel = config.model;
    delete config.model;
    if (Object.hasOwn(config, "modelId")) {
      changes.push(`Removed ${pathLabel}.model because ${pathLabel}.modelId is already set.`);
      continue;
    }
    if (typeof legacyModel === "string" && legacyModel.trim()) {
      config.modelId = legacyModel;
      changes.push(`Moved ${pathLabel}.model → ${pathLabel}.modelId.`);
      continue;
    }
    changes.push(
      `Removed invalid ${pathLabel}.model; set ${pathLabel}.modelId to a non-empty string.`,
    );
  }
  // SAFETY: nextRoot is a deep clone of the original config with only model/modelId keys rewritten.
  return { config: nextRoot as T, changes };
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

  // SAFETY: early return above guarantees raw is a plain record.
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
    // SAFETY: nextRoot is a deep clone of the original config with only talk fields moved.
    config: nextRoot as T,
    changes: [
      `Moved talk legacy fields (${movedKeys.join(", ")}) → talk.providers.${providerId} (filled missing provider fields only).`,
    ],
  };
}

function readApiKeyFromProfile(): string | null {
  const home = os.homedir();
  for (const candidate of PROFILE_CANDIDATES) {
    const fullPath = path.join(home, candidate);
    try {
      const text = fs.readFileSync(fullPath, "utf-8");
      const match = text.match(
        /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/,
      );
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore profile read errors.
    }
  }
  return null;
}

export function resolveElevenLabsApiKeyWithProfileFallback(): string | null {
  const envValue = (process.env[ELEVENLABS_API_KEY_ENV] ?? "").trim();
  if (envValue) {
    return envValue;
  }
  return readApiKeyFromProfile();
}
