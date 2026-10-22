import { createMigrationManualItem } from "openclaw/plugin-sdk/migration";
import { parseDateStringTimestampMs as readTimestamp } from "openclaw/plugin-sdk/number-runtime";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readJsonObject } from "./helpers.js";
import type { HermesSource } from "./source.js";

const HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID = "openai-codex";

export type HermesCodexAuthCandidate = {
  access: string;
  accountId?: string;
  refresh: string;
  sourceKind: "hermes-auth-json" | "opencode-auth-json";
  sourceSlot: "provider" | "pool" | "opencode";
  sourceCredentialIndex?: number;
  sourceLabel: string;
  sourcePath: string;
  updatedAt?: number;
};

const HERMES_REAUTH_PROVIDER_MAPPINGS = [
  { sourceProvider: "anthropic", targetProvider: "anthropic" },
  { sourceProvider: "nous", targetProvider: "nous" },
  { sourceProvider: "qwen-oauth", targetProvider: "qwen" },
  { sourceProvider: "qwen-cli", targetProvider: "qwen" },
  { sourceProvider: "qwen-portal", targetProvider: "qwen" },
  { sourceProvider: "minimax-oauth", targetProvider: "minimax-portal" },
  { sourceProvider: "xai-oauth", targetProvider: "xai" },
] as const;
const HERMES_REAUTH_SOURCE_PROVIDERS = new Set<string>(
  HERMES_REAUTH_PROVIDER_MAPPINGS.map((entry) => entry.sourceProvider),
);

export async function readHermesCodexAuthCandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  if (!authPath) {
    return [];
  }
  const auth = await readJsonObject(authPath);
  const providers = isRecord(auth.providers) ? auth.providers : {};
  const provider = isRecord(providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : undefined;
  const pool = isRecord(auth.credential_pool) ? auth.credential_pool : {};
  const entries = Array.isArray(pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : [];
  const candidates: HermesCodexAuthCandidate[] = [];
  for (const [sourceSlot, raw] of [
    ["provider", provider?.tokens],
    ...entries.map((entry) => ["pool", entry] as const),
  ] as const) {
    if (!isRecord(raw)) {
      continue;
    }
    const access = normalizeOptionalString(raw.access_token);
    const refresh = normalizeOptionalString(raw.refresh_token);
    if (!access || !refresh) {
      continue;
    }
    candidates.push({
      access,
      refresh,
      sourceKind: "hermes-auth-json",
      sourceSlot,
      sourceLabel:
        sourceSlot === "provider"
          ? "Hermes active OpenAI Codex provider"
          : (normalizeOptionalString(raw.label) ?? "Hermes OpenAI Codex credential pool"),
      sourcePath: authPath,
      updatedAt:
        sourceSlot === "provider"
          ? readTimestamp(provider?.last_refresh)
          : (readTimestamp(raw.last_refresh) ?? readTimestamp(raw.last_status_at)),
    });
  }
  candidates.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  candidates.forEach((candidate, index) => {
    candidate.sourceCredentialIndex = index;
  });
  return candidates;
}

async function readHermesOAuthProviderIds(authPath: string | undefined): Promise<Set<string>> {
  const parsed = await readJsonObject(authPath);
  const providers = isRecord(parsed.providers)
    ? Object.keys(parsed.providers).filter((provider) =>
        HERMES_REAUTH_SOURCE_PROVIDERS.has(provider),
      )
    : [];
  const pool = isRecord(parsed.credential_pool)
    ? Object.entries(parsed.credential_pool).flatMap(([provider, entries]) =>
        Array.isArray(entries) &&
        entries.some(
          (entry) =>
            isRecord(entry) && normalizeOptionalString(entry.auth_type)?.toLowerCase() === "oauth",
        )
          ? [provider]
          : [],
      )
    : [];
  return new Set([...providers, ...pool]);
}

export async function buildReauthenticationItems(source: HermesSource): Promise<MigrationItem[]> {
  const profileProviders = await readHermesOAuthProviderIds(source.authPath);
  const globalProviders = await readHermesOAuthProviderIds(source.globalAuthPath);
  const items = HERMES_REAUTH_PROVIDER_MAPPINGS.flatMap(({ sourceProvider, targetProvider }) => {
    const sourcePath = profileProviders.has(sourceProvider)
      ? source.authPath
      : globalProviders.has(sourceProvider)
        ? source.globalAuthPath
        : undefined;
    if (!sourcePath) {
      return [];
    }
    return [
      createMigrationManualItem({
        id: `manual:auth-reauthenticate:${targetProvider}`,
        source: sourcePath,
        message: `Hermes ${sourceProvider} credentials cannot be reused safely by OpenClaw.`,
        recommendation:
          targetProvider === "qwen"
            ? "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key."
            : `Authenticate ${targetProvider} in OpenClaw after migration.`,
      }),
    ];
  });
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
