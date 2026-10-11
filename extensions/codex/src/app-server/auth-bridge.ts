/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AgentHarnessPreflightError,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-harness-registration";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  refreshOAuthCredentialForRuntime,
  resolveApiKeyForProfile,
  resolvePersistedAuthProfileOwnerAgentDir,
  type AuthProfileCredential,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  hasUsableOAuthCredential,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import {
  CODEX_AUTH_JSON_FILENAME,
  CODEX_APP_SERVER_API_KEY_ENV_VARS,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  fingerprintApiKeyAuthProfileCacheKey,
  fingerprintTokenAuthProfileCacheKey,
  readCodexCliAuthFileApiKey,
  readFirstNonEmptyEnv,
} from "./auth-cache-key.js";
import {
  CodexAppServerAuthProfileUnavailableError,
  formatCodexAuthProfileUnavailableMessage,
} from "./auth-profile-recovery.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  isCodexAppServerNativeAuthProfile,
  CODEX_APP_SERVER_AUTH_PROVIDER,
  type CodexAppServerAuthProfileLookup,
} from "./auth-profile.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  withClearedEnvironmentVariables,
  withEphemeralCodexAuthStore,
} from "./auth-start-options.js";
import type {
  CodexAppServerAuthRequirement,
  CodexAppServerAuthHandoff,
  CodexAppServerPreparedAuth,
  CodexAppServerPreparedAuthProfileSnapshot,
  CodexAppServerResolvedPreparedAuth,
} from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import {
  ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource,
} from "./computer-use-marketplace.js";
import { ensureOwnedCodexHome } from "./computer-use-service-path.js";
import {
  ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath,
} from "./computer-use-service.js";
import { reconcileManagedCodexComputerUseCache } from "./computer-use-unified.js";
import type { CodexAppServerHomeScope, CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import type {
  CodexChatgptAuthTokensRefreshResponse,
  CodexGetAccountResponse,
  CodexLoginAccountParams,
} from "./protocol.js";
import {
  isCodexResponsesOAuthCredential,
  resolveCodexResponsesOAuthProfileFingerprint,
} from "./responses-oauth.js";
import { codexPrewriteRejectionCause } from "./rpc-error.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS = [
  ...CODEX_APP_SERVER_API_KEY_ENV_VARS,
  "CODEX_ACCESS_TOKEN",
];
const CODEX_APP_SERVER_HOME_ENV_VARS = new Set([CODEX_HOME_ENV_VAR, HOME_ENV_VAR]);
const MAX_COMPUTER_USE_ARTIFACT_OWNERS = 128;
const activeComputerUseArtifactReconciliations = new Map<
  string,
  { appliedCacheBinding?: string; active: number; tail: Promise<void> }
>();
type AuthProfileOrderConfig = Parameters<typeof resolveCodexAppServerAuthProfileId>[0]["config"];
const scopedOAuthRefreshQueues = new WeakMap<
  AuthProfileStore,
  Map<string, Promise<OAuthCredential>>
>();

export async function bridgeCodexAppServerStartOptions(
  params: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> & {
    startOptions: CodexAppServerStartOptions;
    agentId?: string;
    authProfileId?: string | null;
    preparedAuth?: CodexAppServerPreparedAuth;
    authRequirement?: CodexAppServerAuthRequirement;
    pluginConfig?: unknown;
  },
): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const scopeStartOptions = () =>
    withCodexHomeEnvironment(withEphemeralCodexAuthStore(params), params.agentDir);

  if (params.preparedAuth) {
    const scopedStartOptions = await scopeStartOptions();
    return withClearedEnvironmentVariables(
      scopedStartOptions,
      CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS,
    );
  }
  if (params.authProfileId === null) {
    return scopeStartOptions();
  }
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    config: params.config,
  });
  const authProfileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  if (!authProfileId) {
    assertNoUnimportedAgentCodexAuthFile(params);
  }

  const scopedStartOptions = await scopeStartOptions();
  return shouldClearOpenAiApiKeyForCodexAuthProfile({ store, authProfileId })
    ? withClearedEnvironmentVariables(scopedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : scopedStartOptions;
}

function assertNoUnimportedAgentCodexAuthFile(params: {
  startOptions: CodexAppServerStartOptions;
  agentId?: string;
  agentDir?: string;
  authRequirement?: CodexAppServerAuthRequirement;
}): void {
  // Ephemeral stdio starts cannot load this stale file, and the shared-client key
  // separates auth requirements plus fallback identities. Preserve the supported
  // stdio API-key login instead of turning a leftover file into a hard failure.
  if (
    (params.authRequirement === "api-key" || params.authRequirement === "environment-api-key") &&
    resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions: params.startOptions,
      allowNativeAuthFile: params.authRequirement === "api-key",
    })
  ) {
    return;
  }
  if (params.startOptions.transport !== "stdio" || params.startOptions.homeScope === "user") {
    return;
  }
  const codexHome = resolveCodexAppServerHomeDir(params.agentDir);
  const authPath = path.join(codexHome, CODEX_AUTH_JSON_FILENAME);
  // OpenClaw-owned starts force ephemeral Codex auth, so this file would otherwise be
  // ignored and the operator would receive only the downstream authentication error.
  if (!fsSync.existsSync(authPath)) {
    return;
  }
  const targetAgentId = params.agentId?.trim() || "<agent-id>";
  throw new AgentHarnessPreflightError(
    `A Codex auth file exists at ${authPath}, but agent-scoped Codex runs use OpenClaw's auth store and do not read that file. Preview only that credential import with \`openclaw migrate plan codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai\`, then run \`openclaw migrate apply codex --from <codex-home> --agent ${targetAgentId} --include-secrets --item auth:openai --yes\`. If the plan finds no credentials, remove the stale auth file.`,
  );
}

function resolveCodexAppServerAuthProfile(params: CodexAppServerAuthProfileLookup) {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = resolveCodexAppServerAuthProfileStore({ ...params, agentDir });
  const profileId = resolveCodexAppServerAuthProfileId({ ...params, store });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential || !isCodexAppServerAuthProvider(credential.provider)) {
    return undefined;
  }
  return { agentDir, store, profileId, credential };
}

/** Resolves prepared profile login material once so cache identity and RPC login cannot drift. */
export async function resolveCodexAppServerPreparedAuthProfileSnapshot(
  params: CodexAppServerAuthProfileLookup,
): Promise<CodexAppServerPreparedAuthProfileSnapshot | undefined> {
  const profile = resolveCodexAppServerAuthProfile(params);
  if (!profile) {
    return undefined;
  }
  const { agentDir, store, profileId, credential } = profile;
  if (isCodexResponsesOAuthCredential(credential)) {
    return {
      inferenceAuth: "host-oauth",
      // Native Codex also uses API-key auth for auxiliary services. Only this local
      // placeholder may enter native auth; the parent relay owns the real bearer.
      loginParams: { type: "apiKey", apiKey: `openclaw-local-${randomUUID()}` },
      secretFreeCacheKey: await resolveCodexResponsesOAuthProfileFingerprint({
        profileId,
        store,
        agentDir,
        config: params.config,
      }),
    };
  }
  if (credential.type === "oauth" && credential.authFlow === "chatgpt-identity") {
    throw new Error(
      "ChatGPT subscription sharing was not granted; sign in again and enable sharing.",
    );
  }
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    agentDir,
    authProfileId: profileId,
    authProfileStore: store,
    config: params.config,
  });
  if (!loginParams) {
    return undefined;
  }
  const accountId =
    loginParams.type === "chatgptAuthTokens"
      ? loginParams.chatgptAccountId
      : resolveChatgptAccountId(profileId, credential);
  const stableChatgptAccountId = resolveStableChatgptAccountId(credential);
  const secretFreeCacheKey =
    credential.type === "api_key" && loginParams.type === "apiKey"
      ? `${accountId}:${fingerprintApiKeyAuthProfileCacheKey(loginParams.apiKey)}`
      : loginParams.type === "chatgptAuthTokens" &&
          (credential.type === "token" || !stableChatgptAccountId)
        ? `${accountId}:${fingerprintTokenAuthProfileCacheKey(loginParams.accessToken)}`
        : accountId;
  const chatgptAccountId =
    loginParams.type === "chatgptAuthTokens" ? loginParams.chatgptAccountId : undefined;
  return {
    loginParams,
    secretFreeCacheKey,
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
  };
}

/** Maps one prepared route to one mutually exclusive app-server auth handoff. */
export async function resolveCodexAppServerPreparedAuthHandoff(params: {
  authRequirement?: CodexAppServerAuthRequirement;
  resolvedApiKey?: string;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  agentDir?: string;
  /** Required: an omitted scope would silently reintroduce prepared logins on native homes. */
  homeScope: CodexAppServerHomeScope;
  /** Remote execution must never rely on ambient or native-home credentials. */
  requirePreparedAuth?: boolean;
  config?: AuthProfileOrderConfig;
  subscriptionProfileRequiredError: string;
  subscriptionProfileUnusableError: string;
}) {
  // A user-home app-server owns the operator's native Codex account. Codex persists
  // api-key logins into CODEX_HOME/auth.json and swaps the live account for external
  // token logins, so a prepared OpenClaw handoff here would rewrite the account that
  // Codex CLI and Desktop share. Native homes are verified, never logged into.
  const usesNativeHome = params.homeScope === "user";
  const selectedCredential = params.authProfileId
    ? params.authProfileStore.profiles[params.authProfileId]
    : undefined;
  if (isCodexResponsesOAuthCredential(selectedCredential)) {
    if (usesNativeHome || params.requirePreparedAuth || params.authRequirement !== "api-key") {
      throw new Error(
        "ChatGPT subscription sharing requires the managed local Codex API route and an isolated home.",
      );
    }
    const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot(params);
    if (!snapshot || !params.authProfileId) {
      throw new Error("ChatGPT subscription sharing could not prepare the selected profile.");
    }
    return {
      authProfileId: params.authProfileId,
      nativeAuthProfile: false,
      preparedAuth: {
        kind: "profile" as const,
        profileId: params.authProfileId,
        store: params.authProfileStore,
        snapshot,
      },
    };
  }
  if (params.requirePreparedAuth && usesNativeHome) {
    throw createCodexAppServerAuthError(
      'Codex remote-exec cloud placement requires prepared OpenAI auth. Configure an OpenAI API-key, OAuth, or token profile and use appServer.homeScope="agent"; ambient credentials and native Codex auth are not allowed.',
    );
  }
  if (usesNativeHome) {
    return { nativeAuthProfile: true };
  }
  if (params.authRequirement === "api-key") {
    const apiKey = params.resolvedApiKey?.trim();
    if (!apiKey) {
      throw new Error("Prepared Codex API-key route is missing its resolved API key.");
    }
    return {
      nativeAuthProfile: false,
      preparedAuth: { kind: "api-key" as const, apiKey },
    };
  }

  const authProfileId = params.authProfileId?.trim() || undefined;
  if (authProfileId && !params.authProfileStore.profiles[authProfileId]) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(authProfileId),
    );
  }
  const nativeAuthProfile = isCodexAppServerNativeAuthProfile({
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (params.authRequirement !== "subscription" && !params.requirePreparedAuth) {
    return { authProfileId, nativeAuthProfile };
  }
  if (!authProfileId || (params.authRequirement === "subscription" && !nativeAuthProfile)) {
    throw createCodexAppServerAuthError(
      params.requirePreparedAuth
        ? "Codex remote-exec cloud placement requires prepared OpenAI auth. Configure an OpenAI API-key, OAuth, or token profile; ambient CODEX_API_KEY, OPENAI_API_KEY, and native Codex auth are not allowed."
        : params.subscriptionProfileRequiredError,
    );
  }

  const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
    ...params,
    authProfileId,
  });
  if (!snapshot) {
    throw createCodexAppServerAuthError(
      params.requirePreparedAuth
        ? "Codex remote-exec cloud placement could not prepare the selected OpenAI auth profile. Repair or replace the profile, then retry."
        : params.subscriptionProfileUnusableError,
    );
  }
  return {
    authProfileId,
    nativeAuthProfile,
    preparedAuth: {
      kind: "profile" as const,
      profileId: authProfileId,
      store: params.authProfileStore,
      snapshot,
    },
  };
}

export async function resolveCodexAppServerAuthAccountCacheKey(
  params: CodexAppServerAuthProfileLookup,
): Promise<string | undefined> {
  const profile = resolveCodexAppServerAuthProfile(params);
  if (!profile) {
    return undefined;
  }
  const { agentDir, store, profileId, credential } = profile;
  const accountId = resolveChatgptAccountId(profileId, credential);
  if (credential.type === "oauth") {
    return accountId;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store,
    profileId,
    agentDir,
  });
  const value = resolved?.apiKey?.trim();
  if (!value) {
    return accountId;
  }
  const fingerprint =
    credential.type === "api_key"
      ? fingerprintApiKeyAuthProfileCacheKey(value)
      : fingerprintTokenAuthProfileCacheKey(value);
  return `${accountId}:${fingerprint}`;
}

export { resolveCodexAppServerHomeDir } from "./auth-start-options.js";

async function withCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string | undefined,
): Promise<CodexAppServerStartOptions> {
  const codexHome = resolveCodexAppServerLocalHomeDir(startOptions, agentDir);
  const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim()
    ? startOptions.env[HOME_ENV_VAR]
    : undefined;
  await fs.mkdir(codexHome, { recursive: true });
  if (nativeHome) {
    await fs.mkdir(nativeHome, { recursive: true });
  }
  const nextStartOptions: CodexAppServerStartOptions = {
    ...startOptions,
    env: {
      ...startOptions.env,
      [CODEX_HOME_ENV_VAR]: codexHome,
      ...(nativeHome ? { [HOME_ENV_VAR]: nativeHome } : {}),
    },
  };
  if (startOptions.clearEnv) {
    const filtered = startOptions.clearEnv.filter(
      (envVar) => !CODEX_APP_SERVER_HOME_ENV_VARS.has(envVar.trim().toUpperCase()),
    );
    nextStartOptions.clearEnv =
      filtered.length === startOptions.clearEnv.length ? startOptions.clearEnv : filtered;
  } else {
    delete nextStartOptions.clearEnv;
  }
  return nextStartOptions;
}

/** Reconciles Computer Use artifacts for the exact managed command about to start. */
export async function reconcileCodexComputerUseStartArtifacts(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  pluginConfig?: unknown;
  ownsIsolatedCodexHome?: boolean;
  desktopGeneration?: CodexDesktopGeneration;
  assertCurrent?: () => void;
  forceCacheRefresh?: boolean;
}): Promise<void> {
  if (params.startOptions.transport !== "stdio") {
    return;
  }
  const codexHome = resolveCodexAppServerLocalHomeDir(params.startOptions, params.agentDir);
  const key = path.resolve(codexHome);
  let owner = activeComputerUseArtifactReconciliations.get(key);
  if (!owner) {
    owner = { active: 0, tail: Promise.resolve() };
  } else {
    activeComputerUseArtifactReconciliations.delete(key);
  }
  activeComputerUseArtifactReconciliations.set(key, owner);
  owner.active += 1;
  const assertCurrent = () => params.assertCurrent?.();
  const operation = owner.tail.then(async () => {
    assertCurrent();
    const appliedCacheBinding = await reconcileCodexComputerUseStartArtifactsOnce({
      ...params,
      codexHome,
      assertCurrent,
      previousCacheBinding: owner.appliedCacheBinding,
    });
    assertCurrent();
    owner.appliedCacheBinding = appliedCacheBinding;
  });
  owner.tail = operation.catch(() => undefined);
  try {
    await operation;
  } finally {
    owner.active -= 1;
    pruneComputerUseArtifactOwners();
  }
}

async function reconcileCodexComputerUseStartArtifactsOnce(
  params: Parameters<typeof reconcileCodexComputerUseStartArtifacts>[0] & {
    codexHome: string;
    assertCurrent: () => void;
    previousCacheBinding?: string;
  },
): Promise<string | undefined> {
  const codexHome = params.codexHome;
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
  const ownsIsolatedCodexHome =
    params.ownsIsolatedCodexHome ??
    (params.startOptions.homeScope !== "user" &&
      !params.startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim());
  const shouldProvisionComputerUse =
    computerUseConfig.enabled && computerUseConfig.autoInstall && ownsIsolatedCodexHome;
  const provisioningAgentDir = shouldProvisionComputerUse ? params.agentDir : undefined;
  if (shouldProvisionComputerUse && !provisioningAgentDir) {
    throw new Error("Managed Codex Computer Use requires an OpenClaw agent directory");
  }
  if (provisioningAgentDir) {
    await ensureOwnedCodexHome(codexHome, provisioningAgentDir);
  } else {
    await fs.mkdir(codexHome, { recursive: true });
  }
  const desktopCandidates = resolveMacOSDesktopCodexAppPathCandidates();
  const exactDesktopCandidate = desktopCandidates.find(
    (candidate) =>
      path.resolve(candidate.appServerCommandPath) === path.resolve(params.startOptions.command),
  );
  const usesManagedBundledMarketplace =
    !computerUseConfig.marketplaceSource &&
    !computerUseConfig.marketplacePath &&
    !computerUseConfig.marketplaceName;
  const needsBundledMarketplace =
    usesManagedBundledMarketplace ||
    (computerUseConfig.pluginCacheMode === "shared" &&
      !computerUseConfig.marketplaceName &&
      !computerUseConfig.marketplacePath);
  const artifactCandidate = shouldProvisionComputerUse
    ? await resolveCompleteComputerUseArtifactCandidate({
        candidates: exactDesktopCandidate ? [exactDesktopCandidate] : desktopCandidates,
        needsBundledMarketplace,
      })
    : exactDesktopCandidate;
  params.assertCurrent();
  let marketplacePath: string | undefined;
  if (provisioningAgentDir) {
    if (desktopCandidates.length > 0 && !artifactCandidate) {
      throw new CodexComputerUseCandidateArtifactsUnavailableError();
    }
    try {
      marketplacePath = usesManagedBundledMarketplace
        ? await ensureCodexManagedBundledMarketplace({
            codexHome,
            ownershipRoot: provisioningAgentDir,
            computerUsePluginName: computerUseConfig.pluginName,
            computerUseMcpServerName: computerUseConfig.mcpServerName,
            ...(artifactCandidate
              ? {
                  appServerCommand: artifactCandidate.appServerCommandPath,
                  candidates: [artifactCandidate],
                  ownershipCandidates: desktopCandidates,
                }
              : {}),
            assertCurrent: params.assertCurrent,
          })
        : undefined;
      params.assertCurrent();
      if (usesManagedBundledMarketplace && desktopCandidates.length > 0 && !marketplacePath) {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
      const service = await ensureCodexComputerUseServiceApp({
        codexHome,
        ownershipRoot: params.agentDir,
        ...(artifactCandidate
          ? {
              appServerCommand: artifactCandidate.appServerCommandPath,
              sourceAppCandidates: artifactCandidate.computerUseServiceAppPaths,
            }
          : {}),
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent();
      if (desktopCandidates.length > 0 && service.status === "source_missing") {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
    } catch (error) {
      params.assertCurrent();
      if (error instanceof CodexComputerUseCandidateArtifactsUnavailableError) {
        throw error;
      }
      throw new AgentHarnessPreflightError("Codex Computer Use client provisioning failed.", {
        cause: error,
        scope: "harness",
      });
    }
  }
  params.assertCurrent();
  return await reconcileManagedCodexComputerUseCache({
    codexHome,
    config: computerUseConfig,
    ownershipRoot: ownsIsolatedCodexHome ? params.agentDir : undefined,
    managedMarketplacePath: marketplacePath,
    bundledMarketplacePath: artifactCandidate?.bundledMarketplacePath,
    epoch: params.desktopGeneration?.epoch,
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceCacheRefresh,
    previousCacheBinding: params.previousCacheBinding,
  });
}

async function resolveCompleteComputerUseArtifactCandidate(params: {
  candidates: readonly MacOSDesktopCodexAppPathCandidate[];
  needsBundledMarketplace: boolean;
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  for (const candidate of params.candidates) {
    if (
      params.needsBundledMarketplace &&
      !(await resolveCodexManagedBundledMarketplaceSource({ candidates: [candidate] }))
    ) {
      continue;
    }
    if (
      await resolveCodexComputerUseServiceAppSourcePath({
        sourceAppCandidates: candidate.computerUseServiceAppPaths,
      })
    ) {
      return candidate;
    }
  }
  return undefined;
}

function pruneComputerUseArtifactOwners(): void {
  while (activeComputerUseArtifactReconciliations.size > MAX_COMPUTER_USE_ARTIFACT_OWNERS) {
    const inactive = [...activeComputerUseArtifactReconciliations].find(
      ([, owner]) => owner.active === 0,
    );
    if (!inactive) {
      return;
    }
    activeComputerUseArtifactReconciliations.delete(inactive[0]);
  }
}

class CodexComputerUseCandidateArtifactsUnavailableError extends Error {
  readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";

  constructor() {
    super("The selected Codex desktop app does not contain complete Computer Use artifacts.");
    this.name = "CodexComputerUseCandidateArtifactsUnavailableError";
  }
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir?: string;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  startOptions?: CodexAppServerStartOptions;
  config?: AuthProfileOrderConfig;
  assertCurrent?: () => void;
}): Promise<CodexAppServerAuthHandoff | undefined> {
  params.assertCurrent?.();
  if (!params.preparedAuth && params.authProfileId === null) {
    await assertNativeCodexAccountMatchesRoute(
      params.client,
      params.authRequirement,
      params.assertCurrent,
    );
    return undefined;
  }
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.config ?? {});
  let loginParams: CodexLoginAccountParams | undefined =
    params.preparedAuth?.kind === "profile"
      ? params.preparedAuth.snapshot.loginParams
      : params.preparedAuth?.kind === "api-key"
        ? { type: "apiKey", apiKey: params.preparedAuth.apiKey }
        : await resolveCodexAppServerAuthProfileLoginParamsInternal({
            agentDir,
            authProfileId: params.authProfileId ?? undefined,
            authProfileStore: resolveCodexAppServerAuthProfileStore({
              ...params,
              agentDir,
              authProfileId: params.authProfileId ?? undefined,
            }),
            config: params.config,
          });
  if (params.authRequirement === "subscription" && loginParams?.type !== "chatgptAuthTokens") {
    throw createCodexAppServerAuthError(
      "Codex subscription auth profile could not produce login credentials. Sign in with `openclaw models auth login --provider openai`, select that profile, then retry.",
    );
  }
  if (
    !loginParams &&
    (params.authRequirement === "api-key" || params.authRequirement === "environment-api-key") &&
    params.startOptions?.transport === "stdio"
  ) {
    const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
    loginParams = await resolveCodexAppServerFallbackApiKeyLoginParams({
      client: params.client,
      env,
      ...(params.authRequirement === "api-key" ? { codexCliAuthEnv: process.env } : {}),
      assertCurrent: params.assertCurrent,
    });
  }
  if (loginParams) {
    // Refresh and overload backoff can outlive the caller; check at the physical write.
    try {
      await params.client.request("account/login/start", loginParams, {
        assertCurrent: params.assertCurrent,
      });
    } catch (error) {
      throw codexPrewriteRejectionCause(error);
    }
    if (loginParams.type === "chatgptAuthTokens") {
      params.assertCurrent?.();
      return {
        accessFingerprint: fingerprintTokenAuthProfileCacheKey(loginParams.accessToken),
        chatgptAccountId: loginParams.chatgptAccountId,
      };
    }
  }
  return undefined;
}

/**
 * Native-home connections are verified, never logged into. Both directions of the
 * check protect the same billing boundary: a subscription route cannot run without
 * ChatGPT tokens, and a Platform route must not silently spend the operator's
 * ChatGPT plan. An absent account is left alone because the native home may serve a
 * custom model provider that reports no OpenAI account at all.
 */
async function assertNativeCodexAccountMatchesRoute(
  client: CodexAppServerClient,
  authRequirement: CodexAppServerAuthRequirement | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  if (!authRequirement) {
    return;
  }
  const response = await client.request<CodexGetAccountResponse>(
    "account/read",
    { refreshToken: false },
    { assertCurrent },
  );
  const accountType = response.account?.type;
  if (authRequirement === "subscription") {
    if (accountType !== "chatgpt") {
      throw createCodexAppServerAuthError(
        'Codex subscription route requires ChatGPT auth in the native Codex home. Run `codex login` for that home, or use appServer.homeScope="agent" with an OpenClaw OAuth profile, then retry.',
      );
    }
    return;
  }
  if (accountType === "chatgpt") {
    throw createCodexAppServerAuthError(
      'Codex Platform route requires an API-key account, but the native Codex home is signed in with a ChatGPT subscription. Sign that home in with `codex login --with-api-key`, or set appServer.homeScope="agent" so OpenClaw can inject its own key.',
    );
  }
}

function createCodexAppServerAuthError(message: string): Error & { status: 401 } {
  return Object.assign(new Error(message), { status: 401 as const });
}

export async function refreshCodexAppServerAuthTokens(
  params: CodexAppServerAuthProfileLookup & {
    agentDir: string;
    authHandoff?: CodexAppServerAuthHandoff;
    previousAccountId?: string | null;
  },
): Promise<CodexChatgptAuthTokensRefreshResponse> {
  const previousAccountId = params.previousAccountId?.trim();
  const handoffAccountId = params.authHandoff?.chatgptAccountId.trim();
  if (previousAccountId && handoffAccountId && previousAccountId !== handoffAccountId) {
    throw codexWorkspaceChangedError("before");
  }
  if (previousAccountId) {
    const store = resolveCodexAppServerAuthProfileStore(params);
    const profileId = resolveCodexAppServerAuthProfileId({ ...params, store });
    const credential = profileId ? store.profiles[profileId] : undefined;
    const selectedAccountId = credential
      ? (resolveExplicitChatgptAccountId(credential) ??
        (credential.type === "oauth"
          ? resolveOpenAICodexAuthIdentity({ access: credential.access }).accountId
          : undefined))
      : undefined;
    if (selectedAccountId && selectedAccountId !== previousAccountId) {
      throw codexWorkspaceChangedError("before");
    }
  }
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    ...params,
    forceOAuthRefresh: true,
  });
  if (!loginParams || loginParams.type !== "chatgptAuthTokens") {
    throw new Error(
      "Codex app-server ChatGPT token refresh requires an OAuth auth profile. Sign in with `openclaw models auth login --provider openai`, select that profile, then retry.",
    );
  }
  if (
    (previousAccountId && loginParams.chatgptAccountId !== previousAccountId) ||
    (params.authHandoff && loginParams.chatgptAccountId !== params.authHandoff.chatgptAccountId)
  ) {
    throw codexWorkspaceChangedError("during");
  }
  return {
    accessToken: loginParams.accessToken,
    chatgptAccountId: loginParams.chatgptAccountId,
    chatgptPlanType: loginParams.chatgptPlanType ?? null,
  };
}

async function resolveCodexAppServerAuthProfileLoginParamsInternal(
  params: CodexAppServerAuthProfileLookup & {
    agentDir: string;
    authHandoff?: CodexAppServerAuthHandoff;
    previousAccountId?: string | null;
    forceOAuthRefresh?: boolean;
  },
): Promise<CodexLoginAccountParams | undefined> {
  const store = resolveCodexAppServerAuthProfileStore(params);
  const profileId = resolveCodexAppServerAuthProfileId({ ...params, store });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(profileId),
    );
  }
  if (!isCodexAppServerAuthProvider(credential.provider)) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.`,
    );
  }
  const preferStoreCredential = Boolean(params.authProfileStore?.profiles[profileId]);
  let loginCredential = credential;
  let value: string | undefined;
  let useApiKey = false;
  // Runtime honors the persisted type; credential-entry owners remediate legacy shapes.
  if (credential.type === "api_key" || credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.config,
      store: preferStoreCredential
        ? store
        : ensureAuthProfileStore(params.agentDir, {
            allowKeychainPrompt: false,
            profileId,
            config: params.config,
          }),
      profileId,
      agentDir: params.agentDir,
    });
    value = resolved?.apiKey?.trim();
    useApiKey = credential.type === "api_key";
  } else {
    loginCredential = await resolveOAuthCredentialForCodexAppServer(profileId, credential, {
      ...params,
      store,
      preferStoreCredential,
      forceRefresh: params.forceOAuthRefresh === true,
    });
    value = loginCredential.access?.trim();
  }
  if (!value) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" does not contain usable credentials. Repair or replace the selected OpenAI credential, then retry.`,
    );
  }
  return useApiKey
    ? { type: "apiKey", apiKey: value }
    : buildChatgptAuthTokensParams(profileId, loginCredential, value);
}

async function resolveCodexAppServerFallbackApiKeyLoginParams(params: {
  client: CodexAppServerClient;
  env: NodeJS.ProcessEnv;
  codexCliAuthEnv?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<CodexLoginAccountParams | undefined> {
  const apiKey =
    readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS) ??
    (params.codexCliAuthEnv ? await readCodexCliAuthFileApiKey(params.codexCliAuthEnv) : undefined);
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<CodexGetAccountResponse>(
    "account/read",
    { refreshToken: false },
    { assertCurrent: params.assertCurrent },
  );
  if (response.account) {
    return undefined;
  }
  return { type: "apiKey", apiKey };
}

async function resolveOAuthCredentialForCodexAppServer(
  profileId: string,
  credential: OAuthCredential,
  params: {
    agentDir: string;
    store: AuthProfileStore;
    preferStoreCredential: boolean;
    forceRefresh: boolean;
    authHandoff?: CodexAppServerAuthHandoff;
    previousAccountId?: string | null;
    config?: AuthProfileOrderConfig;
  },
): Promise<OAuthCredential> {
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir: params.agentDir,
    profileId,
  });
  const persistedCredential = findPersistedAuthProfileCredential({
    agentDir: ownerAgentDir,
    profileId,
  });
  const persistedProfile = params.store.runtimePersistedProfileIds?.includes(profileId);
  const useScopedCredential =
    params.preferStoreCredential &&
    (!persistedProfile ||
      (persistedCredential?.type === "oauth" &&
        isCodexAppServerAuthProvider(persistedCredential.provider) &&
        !isDeepStrictEqual(persistedCredential, credential) &&
        !hasMatchingOAuthIdentity(persistedCredential, credential)));
  if (
    params.preferStoreCredential &&
    persistedProfile &&
    (persistedCredential?.type !== "oauth" ||
      !isCodexAppServerAuthProvider(persistedCredential.provider))
  ) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" is no longer an OpenAI OAuth credential in its persisted OpenClaw store. Run "openclaw doctor" to inspect credential ownership, or select an existing OpenAI profile.`,
    );
  }
  const store = useScopedCredential
    ? params.store
    : resolveCodexAppServerAuthProfileStore({
        agentDir: ownerAgentDir,
        authProfileId: profileId,
        config: params.config,
      });
  const persistedOAuthCredential =
    !useScopedCredential &&
    persistedCredential?.type === "oauth" &&
    isCodexAppServerAuthProvider(persistedCredential.provider)
      ? persistedCredential
      : undefined;
  const ownerCredential = store.profiles[profileId];
  const overlaidOAuthCredential =
    ownerCredential?.type === "oauth" && isCodexAppServerAuthProvider(ownerCredential.provider)
      ? ownerCredential
      : undefined;
  const currentCredential =
    useScopedCredential || !persistedOAuthCredential
      ? overlaidOAuthCredential
      : persistedOAuthCredential;
  const reuseCompletedRotation =
    params.forceRefresh &&
    (Boolean(persistedOAuthCredential) || params.preferStoreCredential) &&
    shouldReuseCompletedCodexOAuthRotation({
      credential: currentCredential,
      authHandoff: params.authHandoff,
      previousAccountId: params.previousAccountId,
    });
  const selectedAccountId = currentCredential
    ? resolveOpenAICodexAuthIdentity(currentCredential).accountId?.trim()
    : undefined;
  const callbackAccountId =
    params.authHandoff?.chatgptAccountId.trim() ?? params.previousAccountId?.trim() ?? undefined;
  if (callbackAccountId && selectedAccountId && callbackAccountId !== selectedAccountId) {
    throw codexWorkspaceChangedError("before");
  }
  const expectedAccountId = callbackAccountId ?? selectedAccountId;
  if (useScopedCredential && overlaidOAuthCredential) {
    return await resolveScopedOAuthCredential({
      store,
      profileId,
      credential: overlaidOAuthCredential,
      forceRefresh: params.forceRefresh && !reuseCompletedRotation,
      expectedAccountId,
      config: params.config,
    });
  }
  if (params.forceRefresh && !persistedOAuthCredential && overlaidOAuthCredential) {
    const refreshedRuntimeCredential = await refreshOAuthCredentialForRuntime({
      credential: overlaidOAuthCredential,
      cfg: params.config,
    });
    if (!refreshedRuntimeCredential?.access?.trim()) {
      throw new Error(
        `Codex app-server auth profile "${profileId}" could not refresh. Sign in again with OpenClaw, then retry.`,
      );
    }
    assertCodexOAuthRefreshWorkspace(profileId, refreshedRuntimeCredential, expectedAccountId);
    store.profiles[profileId] = refreshedRuntimeCredential;
    return refreshedRuntimeCredential;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store,
    profileId,
    agentDir: ownerAgentDir,
    forceRefresh:
      params.forceRefresh && Boolean(persistedOAuthCredential) && !reuseCompletedRotation,
    allowProfileFallback: false,
    ...(expectedAccountId
      ? {
          validateOAuthCredential: (candidate: OAuthCredential) =>
            assertCodexOAuthRefreshWorkspace(profileId, candidate, expectedAccountId),
        }
      : {}),
  });
  if (
    !resolved ||
    resolved.credential?.type !== "oauth" ||
    !isCodexAppServerAuthProvider(resolved.credential.provider) ||
    !resolved.apiKey.trim()
  ) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" could not resolve usable OAuth credentials from its OpenClaw credential store. Run "openclaw doctor" to inspect credential ownership, or select an existing OpenAI profile.`,
    );
  }
  const candidate = { ...resolved.credential, access: resolved.apiKey };
  if (isDeepStrictEqual(params.store.profiles[profileId], credential)) {
    // Persisted refreshes rotate refresh tokens. Keep an isolated prepared
    // store aligned without reverting a concurrent caller-owned replacement.
    params.store.profiles[profileId] = candidate;
  }
  return candidate;
}

function shouldReuseCompletedCodexOAuthRotation(params: {
  credential: OAuthCredential | undefined;
  authHandoff: CodexAppServerAuthHandoff | undefined;
  previousAccountId?: string | null;
}): boolean {
  const handoff = params.authHandoff;
  const credential = params.credential;
  if (
    !handoff ||
    !credential ||
    !hasUsableOAuthCredential(credential) ||
    fingerprintTokenAuthProfileCacheKey(credential.access.trim()) === handoff.accessFingerprint
  ) {
    return false;
  }
  const accountId = resolveOpenAICodexAuthIdentity(credential).accountId?.trim();
  const previousAccountId = params.previousAccountId?.trim();
  return (
    accountId === handoff.chatgptAccountId &&
    (!previousAccountId || previousAccountId === handoff.chatgptAccountId)
  );
}

function hasMatchingOAuthIdentity(persisted: OAuthCredential, supplied: OAuthCredential): boolean {
  // Claim-only workspaces must stay distinct even when their emails match,
  // or a scoped refresh can overwrite a replacement persisted account.
  const persistedAccountId = resolveOpenAICodexAuthIdentity(persisted).accountId?.trim();
  const suppliedAccountId = resolveOpenAICodexAuthIdentity(supplied).accountId?.trim();
  if (persistedAccountId && suppliedAccountId) {
    return persistedAccountId === suppliedAccountId;
  }
  const persistedEmail = persisted.email?.trim().toLowerCase();
  const suppliedEmail = supplied.email?.trim().toLowerCase();
  return Boolean(persistedEmail && suppliedEmail && persistedEmail === suppliedEmail);
}

async function resolveScopedOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  forceRefresh: boolean;
  expectedAccountId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<OAuthCredential> {
  const existingRefresh = scopedOAuthRefreshQueues.get(params.store)?.get(params.profileId);
  if (existingRefresh) {
    const refreshed = await existingRefresh;
    assertCodexOAuthRefreshWorkspace(params.profileId, refreshed, params.expectedAccountId);
    return refreshed;
  }
  if (!params.forceRefresh && hasUsableOAuthCredential(params.credential)) {
    return params.credential;
  }

  const storeRefreshes = scopedOAuthRefreshQueues.get(params.store) ?? new Map();
  scopedOAuthRefreshQueues.set(params.store, storeRefreshes);
  const refresh = (async () => {
    const current = params.store.profiles[params.profileId];
    const credential = current?.type === "oauth" ? current : params.credential;
    if (!params.forceRefresh && hasUsableOAuthCredential(credential)) {
      return credential;
    }
    const refreshed = await refreshOAuthCredentialForRuntime({ credential, cfg: params.config });
    if (!refreshed?.access?.trim()) {
      throw new Error(
        `Codex app-server auth profile "${params.profileId}" could not refresh. Sign in again with OpenClaw, then retry.`,
      );
    }
    assertCodexOAuthRefreshWorkspace(params.profileId, refreshed, params.expectedAccountId);
    if (!isDeepStrictEqual(params.store.profiles[params.profileId], credential)) {
      throw new Error(
        `Codex app-server auth profile "${params.profileId}" changed while refreshing. Retry with the newly selected OpenAI profile.`,
      );
    }
    params.store.profiles[params.profileId] = refreshed;
    return refreshed;
  })();
  storeRefreshes.set(params.profileId, refresh);
  try {
    return await refresh;
  } finally {
    // Scoped stores are process-local; serialize their rotating refresh token
    // and release the queue entry with the refresh that owns it.
    if (storeRefreshes.get(params.profileId) === refresh) {
      storeRefreshes.delete(params.profileId);
    }
  }
}

function codexWorkspaceChangedError(phase: "before" | "during"): Error {
  return new Error(
    `ChatGPT workspace changed ${phase} Codex token refresh. Retry to start a client for the selected workspace.`,
  );
}

function assertCodexOAuthRefreshWorkspace(
  profileId: string,
  credential: OAuthCredential,
  expectedAccountId: string | undefined,
): void {
  if (!expectedAccountId) {
    return;
  }
  const loginParams = buildChatgptAuthTokensParams(profileId, credential, credential.access.trim());
  if (loginParams.chatgptAccountId !== expectedAccountId) {
    throw codexWorkspaceChangedError("during");
  }
}

// Runtime consumes canonical auth state; doctor owns retired profile-id migration.
function isCodexAppServerAuthProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === CODEX_APP_SERVER_AUTH_PROVIDER;
}

function shouldClearOpenAiApiKeyForCodexAuthProfile(params: {
  store: ReturnType<typeof ensureAuthProfileStore>;
  authProfileId?: string;
}): boolean {
  const profileId = params.authProfileId?.trim();
  const credential = profileId
    ? params.store.profiles[profileId]
    : params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
  if (!credential || !isCodexAppServerAuthProvider(credential.provider)) {
    return false;
  }
  return credential.type === "oauth" || credential.type === "token";
}

function buildChatgptAuthTokensParams(
  profileId: string,
  credential: AuthProfileCredential,
  accessToken: string,
): Extract<CodexLoginAccountParams, { type: "chatgptAuthTokens" }> {
  const storedAccountId = resolveExplicitChatgptAccountId(credential);
  const tokenAccountId = resolveOpenAICodexAuthIdentity({ access: accessToken }).accountId;
  if (storedAccountId && tokenAccountId && storedAccountId !== tokenAccountId) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" has a different ChatGPT account ID than its access token. Sign in again before retrying.`,
    );
  }
  const chatgptAccountId = storedAccountId ?? tokenAccountId;
  if (!chatgptAccountId) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Codex app-server auth profile "${profileId}" is missing its ChatGPT account ID. Sign in again before retrying.`,
    );
  }
  return {
    type: "chatgptAuthTokens",
    accessToken,
    chatgptAccountId,
    chatgptPlanType: resolveChatgptPlanType(credential),
  };
}

function resolveChatgptPlanType(credential: AuthProfileCredential): string | null {
  const record = credential as Record<string, unknown>;
  const planType = record.chatgptPlanType ?? record.planType;
  return typeof planType === "string" && planType.trim() ? planType.trim() : null;
}

function resolveChatgptAccountId(profileId: string, credential: AuthProfileCredential): string {
  return resolveStableChatgptAccountId(credential) ?? profileId;
}

function resolveStableChatgptAccountId(credential: AuthProfileCredential): string | undefined {
  return resolveExplicitChatgptAccountId(credential) ?? (credential.email?.trim() || undefined);
}

function resolveExplicitChatgptAccountId(credential: AuthProfileCredential): string | undefined {
  return "accountId" in credential && typeof credential.accountId === "string"
    ? credential.accountId.trim() || undefined
    : undefined;
}
