// Migrate Hermes plugin module implements auth behavior.
import { createHash } from "node:crypto";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthStorePathForDisplay,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  createMigrationItem,
  createMigrationManualItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOpenAICodexCredentialExtra,
  buildOauthProviderAuthResult,
  resolveOpenAICodexAccessTokenExpiry,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  updateAuthProfileStoreWithLock,
  type AuthProfileStore,
  type OAuthCredential,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  applyAgentDefaultModelPrimary,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  applyAuthProfileConfigWithConflictCheck,
  hasAuthProfileConfigConflict,
  hasCurrentAuthProfileConfigConflict,
  type HermesAuthProfileConfig,
} from "./auth-config.js";
import { isRecord, readString, readText } from "./helpers.js";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
  HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE,
  HERMES_REASON_INCLUDE_SECRETS,
  HERMES_REASON_MISSING_SECRET_METADATA,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import type { HermesSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

const OPENAI_PROVIDER_ID = "openai";
const HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.6-sol";
const HERMES_AUTH_DISPLAY_NAME = "Hermes import";

type AgentDefaultModelConfigs = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]
>;
type AgentDefaultModelConfigEntry = AgentDefaultModelConfigs[string];

type HermesCodexAuthCandidate = {
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

type HermesCodexAuthProfile = {
  candidate: HermesCodexAuthCandidate;
  credential: OAuthCredential;
  result: ProviderAuthResult;
  sourceProfileId: string;
};

const HERMES_REAUTH_PROVIDER_MAPPINGS = [
  { sourceProvider: "anthropic", targetProvider: "anthropic" },
  { sourceProvider: "nous", targetProvider: "nous" },
  { sourceProvider: "qwen-oauth", targetProvider: "qwen-oauth" },
  { sourceProvider: "minimax-oauth", targetProvider: "minimax-portal" },
  { sourceProvider: "xai-oauth", targetProvider: "xai" },
] as const;
const HERMES_REAUTH_SOURCE_PROVIDERS = new Set<string>(
  HERMES_REAUTH_PROVIDER_MAPPINGS.map((entry) => entry.sourceProvider),
);

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

function sourceCredentialFingerprint(candidate: HermesCodexAuthCandidate): string {
  const hash = createHash("sha256");
  for (const part of [
    candidate.sourceKind,
    candidate.accountId ?? "",
    candidate.access,
    candidate.refresh,
  ]) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readHermesProviderCandidate(
  auth: Record<string, unknown>,
  sourcePath: string,
): HermesCodexAuthCandidate | undefined {
  const providers = isRecord(auth.providers) ? auth.providers : {};
  const provider = isRecord(providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : undefined;
  const tokens = isRecord(provider?.tokens) ? provider.tokens : undefined;
  const access = readString(tokens?.access_token);
  const refresh = readString(tokens?.refresh_token);
  if (!access || !refresh) {
    return undefined;
  }
  return {
    access,
    refresh,
    sourceKind: "hermes-auth-json",
    sourceSlot: "provider",
    sourceLabel: "Hermes active OpenAI Codex provider",
    sourcePath,
    updatedAt: readTimestamp(provider?.last_refresh),
  };
}

function readHermesPoolCandidates(
  auth: Record<string, unknown>,
  sourcePath: string,
): HermesCodexAuthCandidate[] {
  const pool = isRecord(auth.credential_pool) ? auth.credential_pool : {};
  const entries = Array.isArray(pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const access = readString(entry.access_token);
    const refresh = readString(entry.refresh_token);
    if (!access || !refresh) {
      return [];
    }
    return [
      {
        access,
        refresh,
        sourceKind: "hermes-auth-json" as const,
        sourceSlot: "pool" as const,
        sourceLabel: readString(entry.label) ?? "Hermes OpenAI Codex credential pool",
        sourcePath,
        updatedAt: readTimestamp(entry.last_refresh) ?? readTimestamp(entry.last_status_at),
      },
    ];
  });
}

async function readHermesCodexAuthCandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  const raw = await readText(authPath);
  if (!raw || !authPath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const candidates = [
    readHermesProviderCandidate(parsed, authPath),
    ...readHermesPoolCandidates(parsed, authPath),
  ]
    .filter((candidate): candidate is HermesCodexAuthCandidate => candidate !== undefined)
    .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  candidates.forEach((candidate, index) => {
    candidate.sourceCredentialIndex = index;
  });
  return candidates;
}

async function readHermesOAuthProviderIds(authPath: string | undefined): Promise<Set<string>> {
  const raw = await readText(authPath);
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Set();
    }
    const providers = isRecord(parsed.providers)
      ? Object.keys(parsed.providers).filter((provider) =>
          HERMES_REAUTH_SOURCE_PROVIDERS.has(provider),
        )
      : [];
    const pool = isRecord(parsed.credential_pool)
      ? Object.entries(parsed.credential_pool).flatMap(([provider, entries]) =>
          Array.isArray(entries) &&
          entries.some(
            (entry) => isRecord(entry) && readString(entry.auth_type)?.toLowerCase() === "oauth",
          )
            ? [provider]
            : [],
        )
      : [];
    return new Set([...providers, ...pool]);
  } catch {
    return new Set();
  }
}

async function buildReauthenticationItems(source: HermesSource): Promise<MigrationItem[]> {
  const profileProviders = await readHermesOAuthProviderIds(source.authPath);
  const globalProviders = await readHermesOAuthProviderIds(source.globalAuthPath);
  return HERMES_REAUTH_PROVIDER_MAPPINGS.flatMap(({ sourceProvider, targetProvider }) => {
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
        recommendation: `Authenticate ${targetProvider} in OpenClaw after migration.`,
      }),
    ];
  });
}

async function readOpenCodeOpenAICandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  const raw = await readText(authPath);
  if (!raw || !authPath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const openai = isRecord(parsed.openai) ? parsed.openai : undefined;
  const access = readString(openai?.access);
  const accountId = readString(openai?.accountId);
  const refresh = readString(openai?.refresh);
  if (!access || !refresh) {
    return [];
  }
  return [
    {
      access,
      ...(accountId ? { accountId } : {}),
      refresh,
      sourceKind: "opencode-auth-json",
      sourceSlot: "opencode",
      sourceCredentialIndex: 0,
      sourceLabel: "OpenCode OpenAI OAuth credential",
      sourcePath: authPath,
    },
  ];
}

function buildAuthResult(
  candidate: HermesCodexAuthCandidate,
  fallbackProfileName = "hermes-import",
): ProviderAuthResult {
  const identity = resolveOpenAICodexAuthIdentity({
    access: candidate.access,
    accountId: candidate.accountId,
  });
  return buildOauthProviderAuthResult({
    providerId: OPENAI_PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: candidate.access,
    refresh: candidate.refresh,
    expires: resolveOpenAICodexAccessTokenExpiry(candidate.access),
    email: identity.email,
    profileName: resolveOpenAICodexImportProfileName(identity, fallbackProfileName),
    displayName: HERMES_AUTH_DISPLAY_NAME,
    credentialExtra: buildOpenAICodexCredentialExtra(identity),
  });
}

function readProviderAuthModelConfigs(result: ProviderAuthResult): AgentDefaultModelConfigs {
  const models = result.configPatch?.agents?.defaults?.models;
  if (isRecord(models)) {
    return { ...models };
  }
  const defaultModel = readString(result.defaultModel) ?? OPENAI_CODEX_DEFAULT_MODEL;
  return { [defaultModel]: {} };
}

function mergeModelConfigEntry(
  existing: AgentDefaultModelConfigEntry | undefined,
  patch: AgentDefaultModelConfigEntry,
): AgentDefaultModelConfigEntry {
  if (existing && isRecord(existing) && isRecord(patch)) {
    return { ...existing, ...patch } as AgentDefaultModelConfigEntry;
  }
  return existing ?? patch;
}

function applyOAuthModelConfigsToConfig(
  cfg: OpenClawConfig,
  result: ProviderAuthResult,
): OpenClawConfig {
  const patchModels = readProviderAuthModelConfigs(result);
  const existingModels = cfg.agents?.defaults?.models ?? {};
  const models: AgentDefaultModelConfigs = result.replaceDefaultModels
    ? { ...patchModels }
    : { ...existingModels };
  if (!result.replaceDefaultModels) {
    for (const [modelRef, modelConfig] of Object.entries(patchModels)) {
      models[modelRef] = mergeModelConfigEntry(models[modelRef], modelConfig);
    }
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

function authProfileDedupeKey(profile: HermesCodexAuthProfile): string {
  if (profile.credential.accountId) {
    return `${profile.credential.provider}:account:${profile.credential.accountId}`;
  }
  if (profile.credential.email) {
    return `${profile.credential.provider}:email:${profile.credential.email}`;
  }
  return `${profile.credential.provider}:profile:${profile.sourceProfileId}`;
}

async function readCodexAuthProfilesFromSource(
  source: HermesSource,
): Promise<HermesCodexAuthProfile[]> {
  const profileHermesCandidates = await readHermesCodexAuthCandidates(source.authPath);
  const globalHermesCandidates = await readHermesCodexAuthCandidates(source.globalAuthPath);
  const profileProvider = profileHermesCandidates.find(
    (candidate) => candidate.sourceSlot === "provider",
  );
  const profilePool = profileHermesCandidates.filter(
    (candidate) => candidate.sourceSlot === "pool",
  );
  const globalProvider = globalHermesCandidates.find(
    (candidate) => candidate.sourceSlot === "provider",
  );
  const globalPool = globalHermesCandidates.filter((candidate) => candidate.sourceSlot === "pool");
  const candidates = [
    ...(profileProvider ? [profileProvider] : globalProvider ? [globalProvider] : []),
    ...(profilePool.length > 0 ? profilePool : globalPool),
    ...(await readOpenCodeOpenAICandidates(source.opencodeAuthPath)),
  ].toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  const profiles: HermesCodexAuthProfile[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const fallbackProfileName =
      candidates.length === 1 ? "hermes-import" : `hermes-import-${index + 1}`;
    const result = buildAuthResult(candidate, fallbackProfileName);
    const profile = result.profiles[0];
    if (!profile || profile.credential.type !== "oauth") {
      continue;
    }
    const entry = {
      candidate,
      credential: profile.credential,
      result,
      sourceProfileId: profile.profileId,
    };
    const dedupeKey = authProfileDedupeKey(entry);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    profiles.push(entry);
  }
  return profiles;
}

async function readCodexAuthProfilesFromPath(params: {
  sourcePath: string | undefined;
  sourceKind: unknown;
}): Promise<HermesCodexAuthProfile[]> {
  if (params.sourceKind === "opencode-auth-json") {
    return await readCodexAuthProfilesFromSource({
      root: "",
      archivePaths: [],
      ...(params.sourcePath ? { opencodeAuthPath: params.sourcePath } : {}),
    });
  }
  return await readCodexAuthProfilesFromSource({
    root: "",
    archivePaths: [],
    ...(params.sourcePath ? { authPath: params.sourcePath } : {}),
  });
}

function findMatchingProfile(
  store: AuthProfileStore,
  credential: OAuthCredential,
): string | undefined {
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.type !== "oauth" || existing.provider !== credential.provider) {
      continue;
    }
    if (credential.accountId && existing.accountId === credential.accountId) {
      return profileId;
    }
    const canMatchByEmail = !credential.accountId || !existing.accountId;
    if (canMatchByEmail && credential.email && existing.email === credential.email) {
      return profileId;
    }
  }
  return undefined;
}

function oauthAuthProfileConfig(
  profileId: string,
  credential: OAuthCredential,
): HermesAuthProfileConfig {
  return {
    profileId,
    provider: credential.provider,
    mode: "oauth",
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.displayName ? { displayName: credential.displayName } : {}),
  };
}

function matchesSourceCredentialFingerprint(
  profile: HermesCodexAuthProfile,
  fingerprint: string,
): boolean {
  return sourceCredentialFingerprint(profile.candidate) === fingerprint;
}

function findPlannedAuthProfile(params: {
  profiles: HermesCodexAuthProfile[];
  sourceProfileId: string;
  sourceCredentialIndex?: number;
  sourceCredentialFingerprint?: string;
}): HermesCodexAuthProfile | undefined {
  const bySourceProfileId = params.profiles.find(
    (entry) => entry.sourceProfileId === params.sourceProfileId,
  );
  const fingerprint = params.sourceCredentialFingerprint;
  if (!fingerprint) {
    return bySourceProfileId;
  }
  if (bySourceProfileId && matchesSourceCredentialFingerprint(bySourceProfileId, fingerprint)) {
    return bySourceProfileId;
  }
  const byIndex =
    params.sourceCredentialIndex === undefined
      ? undefined
      : params.profiles.find(
          (entry) => entry.candidate.sourceCredentialIndex === params.sourceCredentialIndex,
        );
  if (byIndex && matchesSourceCredentialFingerprint(byIndex, fingerprint)) {
    return byIndex;
  }
  return params.profiles.find((entry) => matchesSourceCredentialFingerprint(entry, fingerprint));
}

export async function buildAuthItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  items.push(...(await buildReauthenticationItems(params.source)));
  const profiles = await readCodexAuthProfilesFromSource(params.source);
  if (profiles.length === 0) {
    return items;
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  items.push(
    ...profiles.map((profile) => {
      const matchedProfileId = findMatchingProfile(store, profile.credential);
      const profileId = matchedProfileId ?? profile.sourceProfileId;
      const targetExists = Boolean(store.profiles[profileId]);
      const skipped = !params.ctx.includeSecrets;
      const configConflict = hasAuthProfileConfigConflict(
        params.ctx.config,
        oauthAuthProfileConfig(profileId, profile.credential),
        Boolean(params.ctx.overwrite),
      );
      const conflict =
        ((targetExists && !matchedProfileId && !params.ctx.overwrite) || configConflict) &&
        !skipped;
      const itemId =
        profiles.length === 1
          ? `auth:${OPENAI_PROVIDER_ID}`
          : `auth:${OPENAI_PROVIDER_ID}:${profile.sourceProfileId}`;
      return createMigrationItem({
        id: itemId,
        kind: "auth",
        action: skipped ? "skip" : "create",
        source: profile.candidate.sourcePath,
        target: authProfileTarget(params.targets.agentDir, profileId),
        status: skipped ? "skipped" : conflict ? "conflict" : "planned",
        sensitive: true,
        reason: skipped
          ? HERMES_REASON_INCLUDE_SECRETS
          : conflict
            ? HERMES_REASON_AUTH_PROFILE_EXISTS
            : undefined,
        message: skipped
          ? `OpenAI OAuth credentials detected in ${profile.candidate.sourceKind === "hermes-auth-json" ? "Hermes" : "OpenCode"}.`
          : "Import OpenAI OAuth credentials and configure OpenAI models.",
        details: {
          provider: OPENAI_PROVIDER_ID,
          profileId,
          ...(typeof profile.candidate.sourceCredentialIndex === "number"
            ? { sourceCredentialIndex: profile.candidate.sourceCredentialIndex }
            : {}),
          sourceCredentialFingerprint: sourceCredentialFingerprint(profile.candidate),
          sourceProfileId: profile.sourceProfileId,
          sourceKind: profile.candidate.sourceKind,
          sourceLabel: profile.candidate.sourceLabel,
        },
      });
    }),
  );
  return items;
}

export async function applyAuthItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  targets: PlannedTargets,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const source = item.source;
  const profileId = typeof item.details?.profileId === "string" ? item.details.profileId : "";
  const sourceProfileId =
    typeof item.details?.sourceProfileId === "string" ? item.details.sourceProfileId : profileId;
  const sourceCredentialIndex =
    typeof item.details?.sourceCredentialIndex === "number"
      ? item.details.sourceCredentialIndex
      : undefined;
  const sourceCredentialFingerprintLocal =
    typeof item.details?.sourceCredentialFingerprint === "string"
      ? item.details.sourceCredentialFingerprint
      : undefined;
  if (!source || !profileId) {
    return markMigrationItemError(item, HERMES_REASON_MISSING_SECRET_METADATA);
  }
  const profiles = await readCodexAuthProfilesFromPath({
    sourcePath: source,
    sourceKind: item.details?.sourceKind,
  });
  const profile = findPlannedAuthProfile({
    profiles,
    sourceProfileId,
    ...(sourceCredentialIndex === undefined ? {} : { sourceCredentialIndex }),
    ...(sourceCredentialFingerprintLocal
      ? { sourceCredentialFingerprint: sourceCredentialFingerprintLocal }
      : {}),
  });
  if (!profile) {
    return markMigrationItemSkipped(item, HERMES_REASON_SECRET_NO_LONGER_PRESENT);
  }
  let conflicted = false;
  let wrote = false;
  const credential = {
    ...profile.credential,
    displayName:
      "displayName" in profile.credential && profile.credential.displayName
        ? profile.credential.displayName
        : HERMES_AUTH_DISPLAY_NAME,
  };
  const configProfile = oauthAuthProfileConfig(profileId, credential);
  if (hasCurrentAuthProfileConfigConflict(ctx, configProfile)) {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  const store = await updateAuthProfileStoreWithLock({
    agentDir: targets.agentDir,
    updater: (freshStore) => {
      const existing = freshStore.profiles[profileId];
      if (!ctx.overwrite && existing) {
        const matchedProfileId = findMatchingProfile(freshStore, credential);
        if (matchedProfileId !== profileId) {
          conflicted = true;
          return false;
        }
        return false;
      }
      freshStore.profiles[profileId] = credential;
      wrote = true;
      return true;
    },
  });
  if (conflicted) {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  if (!store?.profiles[profileId]) {
    return markMigrationItemError(item, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED);
  }
  const configResult = await applyAuthProfileConfigWithConflictCheck({
    ctx,
    profile: configProfile,
    applyConfigPatch(config) {
      const next = applyOAuthModelConfigsToConfig(config, profile.result);
      return resolveAgentModelPrimaryValue(next.agents?.defaults?.model) === undefined
        ? applyAgentDefaultModelPrimary(next, OPENAI_CODEX_DEFAULT_MODEL)
        : next;
    },
  });
  if (configResult === "conflict") {
    return markMigrationItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  return {
    ...item,
    status: "migrated",
    message:
      configResult === "configured"
        ? item.message
        : `${item.message ?? "Imported auth profile."} ${HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE}.`,
    details: {
      ...item.details,
      wroteAuthProfile: wrote,
      configUpdated: configResult === "configured",
    },
  };
}
