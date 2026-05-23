import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyProviderAuthConfigPatch,
  buildOauthProviderAuthResult,
  updateAuthProfileStoreWithLock,
  type AuthProfileStore,
  type OAuthCredential,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  applyAuthProfileConfigWithConflictCheck,
  hasAuthProfileConfigConflict,
  hasCurrentAuthProfileConfigConflict,
  type HermesAuthProfileConfig,
} from "./auth-config.js";
import { readText } from "./helpers.js";
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

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
const HERMES_AUTH_DISPLAY_NAME = "Hermes import";

type HermesCodexAuthCandidate = {
  access: string;
  refresh: string;
  sourceLabel: string;
  updatedAt?: number;
};

type HermesCodexAuthProfile = {
  candidate: HermesCodexAuthCandidate;
  credential: OAuthCredential;
  result: ProviderAuthResult;
  sourceProfileId: string;
};

type CodexIdentity = {
  accountId?: string;
  chatgptPlanType?: string;
  email?: string;
  profileName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveCodexIdentity(access: string): CodexIdentity {
  const payload = decodeJwtPayload(access);
  const auth = isRecord(payload?.["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : {};
  const profile = isRecord(payload?.["https://api.openai.com/profile"])
    ? payload["https://api.openai.com/profile"]
    : {};
  const email = readString(profile.email);
  const accountId = readString(auth.chatgpt_account_id);
  const chatgptPlanType = readString(auth.chatgpt_plan_type);
  if (email) {
    return {
      ...(accountId ? { accountId } : {}),
      ...(chatgptPlanType ? { chatgptPlanType } : {}),
      email,
      profileName: email,
    };
  }
  const stableSubject =
    readString(auth.chatgpt_account_user_id) ??
    readString(auth.chatgpt_user_id) ??
    readString(auth.user_id) ??
    readString(payload?.sub);
  return {
    ...(accountId ? { accountId } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(stableSubject
      ? { profileName: `id-${Buffer.from(stableSubject).toString("base64url")}` }
      : {}),
  };
}

function resolveAccessTokenExpiry(access: string): number | undefined {
  const payload = decodeJwtPayload(access);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return Math.trunc(exp) * 1000;
  }
  if (typeof exp === "string" && /^\d+$/u.test(exp.trim())) {
    return Number.parseInt(exp.trim(), 10) * 1000;
  }
  return undefined;
}

function readProviderTokens(auth: Record<string, unknown>): HermesCodexAuthCandidate | undefined {
  const providers = isRecord(auth.providers) ? auth.providers : {};
  const provider = isRecord(providers[OPENAI_CODEX_PROVIDER_ID])
    ? providers[OPENAI_CODEX_PROVIDER_ID]
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
    sourceLabel: "Hermes active OpenAI Codex provider",
    updatedAt: readTimestamp(provider?.last_refresh),
  };
}

function readPoolTokens(auth: Record<string, unknown>): HermesCodexAuthCandidate[] {
  const pool = isRecord(auth.credential_pool) ? auth.credential_pool : {};
  const entries = Array.isArray(pool[OPENAI_CODEX_PROVIDER_ID])
    ? pool[OPENAI_CODEX_PROVIDER_ID]
    : [];
  const candidates: HermesCodexAuthCandidate[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const access = readString(entry.access_token);
    const refresh = readString(entry.refresh_token);
    if (!access || !refresh) {
      continue;
    }
    const label = readString(entry.label) ?? "Hermes OpenAI Codex credential pool";
    candidates.push({
      access,
      refresh,
      sourceLabel: label,
      updatedAt: readTimestamp(entry.last_refresh) ?? readTimestamp(entry.last_status_at),
    });
  }
  return candidates;
}

async function readHermesCodexAuthCandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  const raw = await readText(authPath);
  if (!raw) {
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
  return [readProviderTokens(parsed), ...readPoolTokens(parsed)]
    .filter((candidate): candidate is HermesCodexAuthCandidate => candidate !== undefined)
    .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function credentialExtra(identity: CodexIdentity): Record<string, unknown> | undefined {
  const extra = {
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
  };
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function importProfileName(identity: CodexIdentity, fallback: string): string {
  if (identity.accountId) {
    return `account-${identity.accountId.replaceAll(/[^A-Za-z0-9._-]+/gu, "-")}`;
  }
  if (identity.profileName?.startsWith("id-")) {
    return identity.profileName;
  }
  return fallback;
}

function buildAuthResult(
  candidate: HermesCodexAuthCandidate,
  fallbackProfileName = "hermes-import",
): ProviderAuthResult {
  const identity = resolveCodexIdentity(candidate.access);
  return buildOauthProviderAuthResult({
    providerId: OPENAI_CODEX_PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: candidate.access,
    refresh: candidate.refresh,
    expires: resolveAccessTokenExpiry(candidate.access),
    email: identity.email,
    profileName: importProfileName(identity, fallbackProfileName),
    displayName: HERMES_AUTH_DISPLAY_NAME,
    credentialExtra: credentialExtra(identity),
  });
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

async function readHermesCodexAuthProfiles(
  authPath: string | undefined,
): Promise<HermesCodexAuthProfile[]> {
  const candidates = await readHermesCodexAuthCandidates(authPath);
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

export async function buildAuthItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]> {
  const profiles = await readHermesCodexAuthProfiles(params.source.authPath);
  if (profiles.length === 0) {
    return [];
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  return profiles.map((profile) => {
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
      ((targetExists && !matchedProfileId && !params.ctx.overwrite) || configConflict) && !skipped;
    const itemId =
      profiles.length === 1
        ? `auth:${OPENAI_CODEX_PROVIDER_ID}`
        : `auth:${OPENAI_CODEX_PROVIDER_ID}:${profile.sourceProfileId}`;
    return createMigrationItem({
      id: itemId,
      kind: "auth",
      action: skipped ? "skip" : "create",
      source: params.source.authPath,
      target: `${params.targets.agentDir}/auth-profiles.json#${profileId}`,
      status: skipped ? "skipped" : conflict ? "conflict" : "planned",
      sensitive: true,
      reason: skipped
        ? HERMES_REASON_INCLUDE_SECRETS
        : conflict
          ? HERMES_REASON_AUTH_PROFILE_EXISTS
          : undefined,
      message: skipped
        ? "OpenAI Codex OAuth credentials detected in Hermes."
        : "Import Hermes OpenAI Codex OAuth credentials and configure OpenAI Codex models.",
      details: {
        provider: OPENAI_CODEX_PROVIDER_ID,
        profileId,
        sourceProfileId: profile.sourceProfileId,
        sourceKind: "hermes-auth-json",
        sourceLabel: profile.candidate.sourceLabel,
      },
    });
  });
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
  if (!source || !profileId) {
    return markMigrationItemError(item, HERMES_REASON_MISSING_SECRET_METADATA);
  }
  const profile = (await readHermesCodexAuthProfiles(source)).find(
    (entry) => entry.sourceProfileId === sourceProfileId,
  );
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
      if (!profile.result.configPatch) {
        return config;
      }
      return applyProviderAuthConfigPatch(config, profile.result.configPatch, {
        replaceDefaultModels: profile.result.replaceDefaultModels,
      });
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
