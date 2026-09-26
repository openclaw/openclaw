import { createHash } from "node:crypto";
import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  mergeMigrationConfigValue,
  resolveMigrationConfigRuntime,
} from "openclaw/plugin-sdk/migration";
import type { PlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  buildOpenAICodexCredentialExtra,
  buildOauthProviderAuthResult,
  hasUsableOAuthCredential,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  updateAuthProfileStoreWithLock,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  findMatchingApiKeyProfile,
  findMatchingOAuthProfile,
  itemProfileTarget,
  LEGACY_CODEX_PROFILE_ID,
  type CodexAuthCredential,
} from "./auth-profile-target.js";
import { readCodexCliCredentialsAsync, type CodexCliCredential } from "./cli-credentials.js";
import { readJsonObject } from "./helpers.js";
import { defaultCodexHome, type CodexSource } from "./source.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_OAUTH_ITEM_ID = "auth:openai";
const OPENAI_API_KEY_ITEM_ID = "auth:openai:api-key";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-6-astra";
const CODEX_IMPORT_DISPLAY_NAME = "Codex import";
const CODEX_REASON_AUTH_NOT_SELECTED = "auth credential migration not selected";
const CODEX_REASON_AUTH_PROFILE_EXISTS = "auth profile exists";
const CODEX_REASON_AUTH_PROFILE_UNUSABLE = "existing OAuth profile requires sign-in";
const CODEX_REASON_AUTH_PROFILE_WRITE_FAILED = "failed to write auth profile";
const CODEX_REASON_AUTH_NO_LONGER_PRESENT = "auth credential no longer present";
const CODEX_REASON_MISSING_AUTH_METADATA = "missing auth metadata";
const CODEX_REASON_AUTH_STORAGE_NOT_IMPORTABLE = "credential storage is not importable";
type CodexConfigPatchMode = "apply" | "none" | "return";

export type CodexAuthSource = Pick<CodexSource, "codexHome" | "authPath" | "modelsCachePath">;

type CodexAuthProfileConfig = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth";
  email?: string;
  displayName?: string;
};

type CodexAuthConfigApplyResult = "configured" | "conflict" | "unavailable";

class CodexAuthConfigConflict extends Error {}

function authItemId(credential: CodexAuthCredential): string {
  // Keep the shipped OAuth id while giving the API-key candidate its own selectable identity.
  return credential.kind === "oauth" ? OPENAI_OAUTH_ITEM_ID : OPENAI_API_KEY_ITEM_ID;
}

function sourceCredentialFingerprint(credential: CodexAuthCredential): string {
  const profile =
    credential.kind === "oauth" ? credential.result.profiles[0]?.credential : undefined;
  const source =
    credential.kind === "api_key"
      ? credential.key
      : profile?.type === "oauth"
        ? [profile.access, profile.refresh, profile.accountId, profile.idToken]
        : undefined;
  return createHash("sha256")
    .update(JSON.stringify([credential.kind, source]))
    .digest("hex");
}

async function readModelRefs(source: CodexAuthSource): Promise<string[]> {
  const cache = await readJsonObject(source.modelsCachePath);
  const models = Array.isArray(cache.models) ? cache.models : [];
  const refs = new Set<string>();
  for (const model of models) {
    const slug =
      typeof model === "string"
        ? model.trim()
        : isRecord(model)
          ? (readString(model.slug) ?? readString(model.id) ?? readString(model.name))
          : undefined;
    if (!slug) {
      continue;
    }
    refs.add(`${OPENAI_PROVIDER_ID}/${slug}`);
  }
  refs.add(OPENAI_CODEX_DEFAULT_MODEL);
  return [...refs].toSorted();
}

async function buildCodexOAuthCredential(
  source: CodexAuthSource,
  credential: CodexCliCredential,
  includeConfigPatch: boolean,
): Promise<CodexAuthCredential | null> {
  const identity = resolveOpenAICodexAuthIdentity({
    access: credential.access,
    accountId: credential.accountId,
  });
  const configPatch = includeConfigPatch
    ? {
        agents: {
          defaults: {
            models: Object.fromEntries(
              (await readModelRefs(source)).map((modelRef) => [modelRef, {}]),
            ),
          },
        },
      }
    : {};
  const result = buildOauthProviderAuthResult({
    providerId: OPENAI_PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    email: identity.email,
    profileName: resolveOpenAICodexImportProfileName(identity, "codex-import"),
    displayName: CODEX_IMPORT_DISPLAY_NAME,
    credentialExtra: buildOpenAICodexCredentialExtra({
      accountId: identity.accountId,
      chatgptPlanType: identity.chatgptPlanType,
      idToken: credential.idToken,
    }),
    configPatch,
  });
  const profile = result.profiles[0];
  return profile
    ? {
        kind: "oauth",
        provider: OPENAI_PROVIDER_ID,
        profileId: profile.profileId,
        result,
      }
    : null;
}

async function readCodexAuthCredentials(
  source: CodexAuthSource,
  options: {
    credentialKind?: CodexAuthCredential["kind"];
    includeConfigPatch: boolean;
    allowKeychainPrompt: boolean;
    signal?: AbortSignal;
  },
): Promise<CodexAuthCredential[]> {
  const credentials = await readCodexCliCredentialsAsync({
    codexHome: source.codexHome,
    credentialKind: options.credentialKind,
    allowKeychainPrompt: options.allowKeychainPrompt,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const oauth = credentials?.oauth
    ? await buildCodexOAuthCredential(source, credentials.oauth, options.includeConfigPatch)
    : null;
  const apiKey: CodexAuthCredential | null = credentials?.apiKey
    ? {
        kind: "api_key",
        provider: OPENAI_PROVIDER_ID,
        profileId: "openai:codex-import",
        key: credentials.apiKey.key,
      }
    : null;
  return [oauth, apiKey].filter((entry): entry is CodexAuthCredential => entry !== null);
}

function replaceConfigDraft(draft: OpenClawConfig, next: OpenClawConfig): void {
  for (const key of Object.keys(draft) as Array<keyof OpenClawConfig>) {
    delete draft[key];
  }
  Object.assign(draft, next);
}

function hasAuthProfileConfigConflict(
  config: OpenClawConfig,
  profile: CodexAuthProfileConfig,
  overwrite: boolean,
): boolean {
  if (overwrite) {
    return false;
  }
  const existing = config.auth?.profiles?.[profile.profileId];
  return Boolean(
    existing &&
    (existing.provider !== profile.provider ||
      existing.mode !== profile.mode ||
      (existing.email && profile.email && existing.email !== profile.email)),
  );
}

function hasCurrentAuthProfileConfigConflict(
  ctx: MigrationProviderContext,
  profile: CodexAuthProfileConfig,
): boolean {
  let config = ctx.config;
  try {
    config =
      (resolveMigrationConfigRuntime(ctx)?.current?.() as OpenClawConfig | undefined) ?? config;
  } catch {
    // Fall back to the planning snapshot; direct config writes recheck inside mutate.
  }
  return hasAuthProfileConfigConflict(config, profile, Boolean(ctx.overwrite));
}

function applyDefaultModelIfMissing(cfg: OpenClawConfig): OpenClawConfig {
  const currentModel = cfg.agents?.defaults?.model;
  const primary =
    typeof currentModel === "string"
      ? currentModel
      : isRecord(currentModel)
        ? readString(currentModel.primary)
        : undefined;
  if (primary) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(isRecord(currentModel) ? currentModel : {}),
          primary: OPENAI_CODEX_DEFAULT_MODEL,
        },
      },
    },
  };
}

export function resolveCodexConfigPatchMode(ctx: MigrationProviderContext): CodexConfigPatchMode {
  const mode = ctx.providerOptions?.configPatchMode;
  return mode === "none" || mode === "return" ? mode : "apply";
}

function allowCodexKeychainPrompt(ctx: MigrationProviderContext): boolean {
  const explicit = ctx.providerOptions?.allowKeychainPrompt;
  return typeof explicit === "boolean" ? explicit : ctx.includeSecrets === true;
}

function resolveRequestedCredentialKind(
  ctx: MigrationProviderContext,
): CodexAuthCredential["kind"] | undefined {
  const kind = ctx.providerOptions?.credentialKind;
  return kind === "oauth" || kind === "api_key" ? kind : undefined;
}

function authProfileConfigForCredential(
  credential: CodexAuthCredential,
  profileId: string,
): CodexAuthProfileConfig | null {
  if (credential.kind === "api_key") {
    return {
      profileId,
      provider: credential.provider,
      mode: "api_key",
      displayName: CODEX_IMPORT_DISPLAY_NAME,
    };
  }
  const profile = credential.result.profiles[0];
  if (!profile || profile.credential.type !== "oauth") {
    return null;
  }
  return {
    profileId,
    provider: profile.credential.provider,
    mode: "oauth",
    ...(profile.credential.email ? { email: profile.credential.email } : {}),
    ...(profile.credential.displayName ? { displayName: profile.credential.displayName } : {}),
  };
}

async function applyCodexAuthProfileConfig(
  ctx: MigrationProviderContext,
  profile: CodexAuthProfileConfig,
  applyConfig: (config: OpenClawConfig) => OpenClawConfig,
): Promise<CodexAuthConfigApplyResult> {
  const configApi = resolveMigrationConfigRuntime(ctx);
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return "unavailable";
  }
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const current = draft;
        if (hasAuthProfileConfigConflict(current, profile, Boolean(ctx.overwrite))) {
          throw new CodexAuthConfigConflict();
        }
        const next = applyConfig(current);
        replaceConfigDraft(draft, next);
      },
    });
    return "configured";
  } catch (error) {
    return error instanceof CodexAuthConfigConflict ? "conflict" : "unavailable";
  }
}

function applyCredentialConfig(
  config: OpenClawConfig,
  credential: CodexAuthCredential,
  profileId: string,
): OpenClawConfig {
  let next =
    credential.kind === "oauth"
      ? (mergeMigrationConfigValue(config, credential.result.configPatch) as OpenClawConfig)
      : config;
  const profile = authProfileConfigForCredential(credential, profileId);
  if (profile) {
    next = applyAuthProfileConfig(next, { ...profile, preferProfileFirst: false });
  }
  return credential.kind === "oauth" ? applyDefaultModelIfMissing(next) : next;
}

export async function buildCodexAuthItems(params: {
  ctx: MigrationProviderContext;
  source: CodexAuthSource;
  targets: PlannedMigrationTargets;
}): Promise<MigrationItem[]> {
  const configPatchMode = resolveCodexConfigPatchMode(params.ctx);
  const allowKeychainPrompt = allowCodexKeychainPrompt(params.ctx);
  const credentials = await readCodexAuthCredentials(params.source, {
    credentialKind: resolveRequestedCredentialKind(params.ctx),
    includeConfigPatch: configPatchMode !== "none",
    allowKeychainPrompt,
    signal: params.ctx.signal,
  });
  if (credentials.length === 0) {
    const requestedKind = resolveRequestedCredentialKind(params.ctx);
    if (!requestedKind && allowKeychainPrompt) {
      return [];
    }
    const offeredKinds = requestedKind ? [requestedKind] : (["oauth", "api_key"] as const);
    return offeredKinds.map((credentialKind) =>
      createMigrationItem({
        id: credentialKind === "api_key" ? OPENAI_API_KEY_ITEM_ID : OPENAI_OAUTH_ITEM_ID,
        kind: "auth",
        action: "skip",
        source: params.source.codexHome,
        status: "skipped",
        sensitive: true,
        reason: allowKeychainPrompt ? CODEX_REASON_AUTH_STORAGE_NOT_IMPORTABLE : undefined,
        message: allowKeychainPrompt
          ? "No supported Codex credential could be imported. Continue with sign-in to connect OpenClaw."
          : "Codex credentials have not been inspected. Confirm credential import to check the current Codex sign-in.",
        details: {
          provider: OPENAI_PROVIDER_ID,
          credentialKind,
          credentialImportUnavailable: true,
        },
      }),
    );
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  const skipped = !params.ctx.includeSecrets;
  return credentials.map((credential) => {
    const { profileId, matchedExisting } = itemProfileTarget(
      credential,
      store,
      params.ctx,
      params.source,
    );
    const existing = store.profiles[profileId];
    const configProfile = authProfileConfigForCredential(credential, profileId);
    const configConflict = configProfile
      ? hasAuthProfileConfigConflict(
          params.ctx.config,
          configProfile,
          Boolean(params.ctx.overwrite),
        )
      : false;
    const conflict =
      ((existing && !matchedExisting && !params.ctx.overwrite) || configConflict) && !skipped;
    const unavailable =
      !skipped &&
      !conflict &&
      !params.ctx.overwrite &&
      existing?.type === "oauth" &&
      !hasUsableOAuthCredential(existing);
    return createMigrationItem({
      id: authItemId(credential),
      kind: "auth",
      action: skipped || unavailable ? "skip" : "create",
      source: params.source.codexHome,
      // Credentials land in the agent's SQLite auth profile store; naming the
      // retired JSON file here promised operators a file that is never created.
      target: `${params.targets.agentDir}/openclaw-agent.sqlite#auth_profile_store:${profileId}`,
      status: skipped || unavailable ? "skipped" : conflict ? "conflict" : "planned",
      sensitive: true,
      reason: skipped
        ? CODEX_REASON_AUTH_NOT_SELECTED
        : conflict
          ? CODEX_REASON_AUTH_PROFILE_EXISTS
          : unavailable
            ? CODEX_REASON_AUTH_PROFILE_UNUSABLE
            : undefined,
      message: unavailable
        ? "The existing OpenAI sign-in needs to be renewed. Continue with sign-in."
        : credential.kind === "oauth"
          ? configPatchMode === "none"
            ? "Import Codex OAuth credentials."
            : "Import Codex OAuth credentials and configure OpenAI Codex models."
          : "Import Codex OpenAI API key.",
      details: {
        provider: credential.provider,
        profileId,
        sourceProfileId: credential.profileId,
        sourceCredentialFingerprint: sourceCredentialFingerprint(credential),
        sourceKind: "codex-native-selected-storage",
        ...(profileId === LEGACY_CODEX_PROFILE_ID && !matchedExisting
          ? { legacyNativeHome: params.source.codexHome }
          : {}),
        credentialKind: credential.kind,
        credentialImportUnavailable: unavailable,
      },
    });
  });
}

type CodexAuthApplyContext = {
  ctx: MigrationProviderContext;
  source: CodexAuthSource;
  targets: PlannedMigrationTargets;
};

export function createCodexAuthItemApplier(
  params: CodexAuthApplyContext & { items: readonly MigrationItem[] },
): (item: MigrationItem) => Promise<MigrationItem[]> {
  const { items, ...context } = params;
  const selectedKinds = new Set(
    items
      .filter((item) => item.kind === "auth" && item.status === "planned")
      .map((item) => item.details?.credentialKind),
  );
  const selectedKind = selectedKinds.size === 1 ? selectedKinds.values().next().value : undefined;
  // Read afresh for this apply invocation, then share it across selected sibling items.
  let snapshot: Promise<CodexAuthCredential[]> | undefined;
  const readCredentials = () =>
    (snapshot ??= readCodexAuthCredentials(context.source, {
      credentialKind:
        selectedKind === "oauth" || selectedKind === "api_key" ? selectedKind : undefined,
      includeConfigPatch: resolveCodexConfigPatchMode(context.ctx) !== "none",
      allowKeychainPrompt: allowCodexKeychainPrompt(context.ctx),
      signal: context.ctx.signal,
    }));
  return (item) => applyCodexAuthItem({ ...context, item, readCredentials });
}

async function applyCodexAuthItem(
  params: CodexAuthApplyContext & {
    item: MigrationItem;
    readCredentials: () => Promise<CodexAuthCredential[]>;
  },
): Promise<MigrationItem[]> {
  const { ctx, item, source, targets } = params;
  if (item.status !== "planned") {
    return [item];
  }
  const profileId = typeof item.details?.profileId === "string" ? item.details.profileId : "";
  const provider = typeof item.details?.provider === "string" ? item.details.provider : "";
  const sourceProfileId =
    typeof item.details?.sourceProfileId === "string" ? item.details.sourceProfileId : undefined;
  const credentialKind = item.details?.credentialKind;
  if (!profileId || !provider || (credentialKind !== "oauth" && credentialKind !== "api_key")) {
    return [markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA)];
  }
  const configPatchMode = resolveCodexConfigPatchMode(ctx);
  ctx.signal?.throwIfAborted();
  const credentials = await params.readCredentials();
  ctx.signal?.throwIfAborted();
  const credential = credentials.find(
    (candidate) =>
      candidate.provider === provider &&
      candidate.kind === credentialKind &&
      (!sourceProfileId || candidate.profileId === sourceProfileId),
  );
  if (!credential) {
    return [markMigrationItemSkipped(item, CODEX_REASON_AUTH_NO_LONGER_PRESENT)];
  }
  if (item.details?.sourceCredentialFingerprint !== sourceCredentialFingerprint(credential)) {
    return [markMigrationItemSkipped(item, CODEX_REASON_AUTH_NO_LONGER_PRESENT)];
  }
  if (
    item.details?.legacyNativeHome !== undefined &&
    (item.details.legacyNativeHome !== source.codexHome || source.codexHome !== defaultCodexHome())
  ) {
    return [markMigrationItemSkipped(item, CODEX_REASON_AUTH_NO_LONGER_PRESENT)];
  }
  ctx.signal?.throwIfAborted();
  const oauthProfile = credential.kind === "oauth" ? credential.result.profiles[0] : undefined;
  const oauthCredential =
    oauthProfile?.credential.type === "oauth" ? oauthProfile.credential : undefined;
  if (credential.kind === "oauth" && !oauthCredential) {
    return [markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA)];
  }
  const configProfile = authProfileConfigForCredential(credential, profileId);
  if (!configProfile) {
    return [markMigrationItemError(item, CODEX_REASON_MISSING_AUTH_METADATA)];
  }
  if (hasCurrentAuthProfileConfigConflict(ctx, configProfile)) {
    return [markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS)];
  }
  let conflicted = false;
  let unusable = false;
  let wrote = false;
  const store = await updateAuthProfileStoreWithLock({
    agentDir: targets.agentDir,
    stateDir: ctx.stateDir,
    updater: (freshStore) => {
      ctx.signal?.throwIfAborted();
      const effectiveStore = loadAuthProfileStoreWithoutExternalProfiles(targets.agentDir);
      if (
        item.details?.legacyNativeHome !== undefined &&
        itemProfileTarget(credential, effectiveStore, ctx, source).profileId !== profileId
      ) {
        conflicted = true;
        return false;
      }
      const existing = effectiveStore.profiles[profileId];
      if (!ctx.overwrite && existing) {
        const matchedProfileId =
          credential.kind === "oauth"
            ? findMatchingOAuthProfile(effectiveStore, oauthCredential!)
            : findMatchingApiKeyProfile(effectiveStore, credential.provider, credential.key);
        if (matchedProfileId === profileId) {
          // A matching account cannot turn an expired or fenced profile into a successful login.
          unusable = existing.type === "oauth" && !hasUsableOAuthCredential(existing);
          return false;
        }
        conflicted = true;
        return false;
      }
      freshStore.profiles[profileId] =
        credential.kind === "oauth"
          ? {
              ...oauthCredential!,
              displayName: CODEX_IMPORT_DISPLAY_NAME,
            }
          : {
              ...buildApiKeyCredential(credential.provider, credential.key),
              displayName: CODEX_IMPORT_DISPLAY_NAME,
            };
      wrote = true;
      return true;
    },
  });
  if (conflicted) {
    return [markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS)];
  }
  if (unusable) {
    return [markMigrationItemSkipped(item, CODEX_REASON_AUTH_PROFILE_UNUSABLE)];
  }
  if (
    !store ||
    !loadAuthProfileStoreWithoutExternalProfiles(targets.agentDir).profiles[profileId]
  ) {
    return [markMigrationItemError(item, CODEX_REASON_AUTH_PROFILE_WRITE_FAILED)];
  }
  const configResult =
    configPatchMode !== "apply"
      ? "unavailable"
      : await applyCodexAuthProfileConfig(ctx, configProfile, (config) =>
          applyCredentialConfig(config, credential, profileId),
        );
  if (configResult === "conflict") {
    return [markMigrationItemConflict(item, CODEX_REASON_AUTH_PROFILE_EXISTS)];
  }
  const migratedItem: MigrationItem = {
    ...item,
    status: "migrated",
    details: {
      ...item.details,
      wroteAuthProfile: wrote,
      configUpdated: configResult === "configured",
      ...(configPatchMode === "return" ? { configPatchReturned: true } : {}),
    },
  };
  return [
    migratedItem,
    ...(configPatchMode === "return"
      ? buildCodexAuthConfigPatchItems(ctx, migratedItem, credential, profileId)
      : []),
  ];
}

function buildCodexAuthConfigPatchItems(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  credential: CodexAuthCredential,
  profileId: string,
): MigrationItem[] {
  const next = applyCredentialConfig(ctx.config, credential, profileId);
  const items: MigrationItem[] = [];
  if (next.auth) {
    items.push(
      createMigrationItem({
        id: `${item.id}:config:auth`,
        kind: "config",
        action: "merge",
        status: "migrated",
        target: "auth",
        message: "Configure imported Codex auth profile.",
        details: {
          path: ["auth"],
          value: next.auth,
        },
      }),
    );
  }
  if (next.agents?.defaults) {
    items.push(
      createMigrationItem({
        id: `${item.id}:config:agents-defaults`,
        kind: "config",
        action: "merge",
        status: "migrated",
        target: "agents.defaults",
        message: "Configure imported Codex models.",
        details: {
          path: ["agents", "defaults"],
          value: next.agents.defaults,
        },
      }),
    );
  }
  return items;
}
