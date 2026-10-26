import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { readSecretFile } from "@openclaw/fs-safe/secret";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument } from "yaml";
import type {
  GitHubIdentityFacts,
  ToolsGitHubStatusResult,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { hasErrnoCode } from "../infra/errno.js";
import { AGENT_GIT_CONFIG_PARAMETERS } from "../infra/git-maintenance-env.js";
import { resolveAgentEntry, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import {
  prepareAppGitHubIdentity,
  configuredAppGitHubIdentityFacts,
  configuredAppGitHubOptionsIdentity,
} from "./github-app-identity.js";
import {
  resolveGitHubApiBaseUrl,
  resolveGitHubHost,
  withGitHubToken,
} from "./github-host-runtime.js";
import { resolveConfiguredGitHubApiBaseUrl } from "./github-host.js";
import { verifyGitHubCredential } from "./github-oauth-client.js";
import { inspectGitHubOAuthRecord } from "./github-oauth-records.js";
import {
  clearNativeGitHubTokenCache,
  createGitHubReadIdentity,
  GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES as PROFILE_OUTPUT_LIMIT_BYTES,
  GitHubIdentityError,
  normalizeGitHubToken as normalizeManagedGitHubToken,
  readCachedNativeGitHubToken,
  readNativeGitHubToken,
  readGitAuthor,
  startGitHubIdentityOperation,
  type GitHubIdentityPreparation,
  type GitHubReadIdentityPreparation,
  type GitHubReadIdentityStarter,
  type PreparedGitHubReadIdentity,
  type PreparedGitHubSourceReadIdentity,
} from "./github-read-identity.js";
import { managedGitHubHosts, type GitHubToolAccount } from "./github-tool-account.js";
import {
  githubCredentialEnvironmentExclusions,
  managedGitHubIdentityEnvironment,
} from "./github-tool-identity-env.js";
import {
  notifyManagedGitHubProfileChanged,
  resolveGitHubPublicationAccessExpiry,
} from "./github-tool-identity-lifecycle.js";
import type {
  PreparedGitHubPublicationIdentity,
  PreparedGitHubToolEnvironment,
} from "./github-tool-identity.types.js";
import { writeManagedGitHubProfileFiles } from "./github-tool-profile-files.js";
import { resolveManagedGitHubProfileDir } from "./github-tool-profile-path.js";

export {
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileDir,
  resolveManagedGitHubProfileRoot,
} from "./github-tool-profile-path.js";
export { onManagedGitHubProfileChanged } from "./github-tool-identity-lifecycle.js";
export { GitHubIdentityError } from "./github-read-identity.js";
export type { PreparedGitHubPublicationIdentity } from "./github-tool-identity.types.js";
export { writeManagedGitHubProfileFiles } from "./github-tool-profile-files.js";

const GITHUB_HOST = "github.com";

export class GitHubAccountMismatchError extends Error {}

export function createManagedGitHubProfileId(): string {
  return `ghp_${randomBytes(16).toString("hex")}`;
}

export function resolveConfiguredGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
}): GitHubToolIdentityConfig | undefined {
  return params.scope === "agent"
    ? resolveAgentEntry(params.config, params.agentId)?.tools?.github
    : params.config.tools?.github;
}

function resolveSystemGitHubToolIdentity(
  params: Pick<GitHubIdentityPreparation, "config" | "env">,
) {
  return (
    resolveScopedGitHubToolIdentity({ ...params, agentId: "", scope: "system" }) ?? {
      source: "system-detected" as const,
    }
  );
}

function resolveGitHubToolIdentity(params: GitHubIdentityPreparation) {
  return (
    resolveScopedGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveSystemGitHubToolIdentity(params)
  );
}

function resolveScopedGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
  env?: NodeJS.ProcessEnv;
}) {
  const config = resolveConfiguredGitHubToolIdentity(params);
  return config
    ? {
        source:
          params.scope === "agent" ? ("agent-override" as const) : ("system-configured" as const),
        config,
        profileDir: resolveManagedGitHubProfileDir({
          agentId: params.agentId,
          env: params.env,
          scope: params.scope,
          profileId: config.profileId,
        }),
      }
    : undefined;
}

type ResolvedGitHubToolIdentity = ReturnType<typeof resolveGitHubToolIdentity>;

/** Prepares the non-secret child overlay and store exclusions once per agent run. */
export function prepareGitHubToolEnvironment(
  params: GitHubIdentityPreparation,
): PreparedGitHubToolEnvironment {
  const identity = resolveGitHubToolIdentity(params);
  if (identity.source !== "system-detected" && identity.config.kind === "app-installation") {
    throw new Error("GitHub Apps support session reads only; select native or OAuth to run tools.");
  }
  return prepareGitHubToolEnvironmentForIdentity(params, identity);
}

function prepareGitHubToolEnvironmentForIdentity(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "agentId">,
  identity: ResolvedGitHubToolIdentity,
): PreparedGitHubToolEnvironment {
  const managedLocalIdentity = identity.source !== "system-detected";
  const { credentialScrubEnv, excludedStoreNames } = githubCredentialEnvironmentExclusions(
    params,
    identity.source === "system-detected" ? undefined : identity.config,
  );
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    localIdentityEnv: Object.freeze(
      managedLocalIdentity
        ? managedGitHubIdentityEnvironment({
            profileDir: identity.profileDir,
            gitAuthor: identity.config.gitAuthor,
          })
        : {},
    ),
    // Execution adapters append this after resolving their native Git configuration.
    localGitConfigParameters: AGENT_GIT_CONFIG_PARAMETERS,
    excludedStoreNames: Object.freeze(excludedStoreNames),
    managedLocalIdentity,
    ...(managedLocalIdentity ? { hostExecutionRequired: true as const } : {}),
  });
}

function githubIdentityProbeEnvironment(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env" | "agentId">,
  identity: ResolvedGitHubToolIdentity,
): NodeJS.ProcessEnv {
  const overlay = prepareGitHubToolEnvironmentForIdentity(params, identity);
  return {
    ...(params.env ?? process.env),
    ...Object.fromEntries(Object.keys(overlay.credentialScrubEnv).map((name) => [name, undefined])),
    ...overlay.localIdentityEnv,
  };
}

async function readManagedGitHubToken(profileDir: string): Promise<string | undefined> {
  if (!(await isPrivateManagedGitHubProfile(profileDir))) {
    return undefined;
  }
  try {
    let hosts: Record<string, unknown> | undefined;
    for (const name of ["hosts.yml", "config.yml"]) {
      const filePath = path.join(profileDir, name);
      const stat = await fs.lstat(filePath).catch((error: unknown) => {
        if (name === "config.yml" && hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        return undefined;
      }
      const raw = await readSecretFile(filePath, "Managed GitHub profile", {
        maxBytes: PROFILE_OUTPUT_LIMIT_BYTES,
        rejectSymlink: true,
      });
      // parse() logs YAML warnings containing file contents. Inspect the document
      // instead so corrupt credentials never escape into parser diagnostics.
      const document = parseDocument(raw, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        return undefined;
      }
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (!isRecord(value)) {
        return undefined;
      }
      if (name === "hosts.yml") {
        hosts = value;
      }
    }
    const host = hosts?.[GITHUB_HOST];
    // gh reads the active host token before considering the global keyring.
    // User-keyed entries alone cannot prove isolation from native auth.
    return isRecord(host) && typeof host.oauth_token === "string"
      ? normalizeManagedGitHubToken(host.oauth_token)
      : undefined;
  } catch {
    return undefined;
  }
}

async function isPrivateManagedGitHubProfile(profileDir: string): Promise<boolean> {
  try {
    const [profile, hosts] = await Promise.all([
      fs.lstat(profileDir),
      fs.lstat(path.join(profileDir, "hosts.yml")),
    ]);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      !hosts.isFile() ||
      hosts.isSymbolicLink()
    ) {
      return false;
    }
    return (
      process.platform === "win32" || ((profile.mode & 0o077) === 0 && (hosts.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

export async function resolveGitHubToolIdentityStatus(
  params: GitHubIdentityPreparation & { selectedScope: "system" | "agent" },
): Promise<ToolsGitHubStatusResult> {
  const effectiveIdentity = resolveGitHubToolIdentity(params);
  const selectedIdentity =
    params.selectedScope === "system"
      ? resolveSystemGitHubToolIdentity(params)
      : resolveScopedGitHubToolIdentity({ ...params, scope: "agent" });
  const probe = {
    config: params.config,
    sourceConfig: params.sourceConfig,
    cwd: resolveAgentWorkspaceDir(params.config, params.agentId),
    agentId: params.agentId,
    env: params.env,
  };
  const effective = await resolveGitHubIdentityFacts({ ...probe, identity: effectiveIdentity });
  const selectedMatchesEffective =
    selectedIdentity?.source === effectiveIdentity.source &&
    (selectedIdentity?.source === "system-detected" ||
      (effectiveIdentity.source !== "system-detected" &&
        selectedIdentity?.config.profileId === effectiveIdentity.config.profileId));
  const selected = !selectedIdentity
    ? null
    : selectedMatchesEffective
      ? effective
      : await resolveGitHubIdentityFacts({ ...probe, identity: selectedIdentity });
  return {
    agentId: params.agentId,
    selectedScope: params.selectedScope,
    selected: {
      scope: params.selectedScope,
      configured: selectedIdentity?.source !== "system-detected" && selectedIdentity !== undefined,
      identity: selected,
    },
    effective,
  };
}

export async function resolveSystemGitHubIdentityStatus(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env">,
): Promise<GitHubIdentityFacts> {
  // Profile settings have no agent owner. Probe the shared identity outside agent workspaces.
  return resolveGitHubIdentityFacts({
    ...params,
    agentId: "",
    identity: resolveSystemGitHubToolIdentity(params),
    cwd: resolveStateDir(params.env),
  });
}

async function resolveGitHubIdentityFacts(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env" | "agentId"> & {
    cwd: string;
    identity: ResolvedGitHubToolIdentity;
  },
): Promise<GitHubIdentityFacts> {
  const identity = params.identity;
  const managed = identity.source !== "system-detected";
  if (managed && identity.config.kind === "app-installation") {
    return configuredAppGitHubIdentityFacts(identity.config, identity.source);
  }
  const probeEnv = githubIdentityProbeEnvironment(params, identity);
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const token = managed
    ? await readManagedGitHubToken(identity.profileDir)
    : await readNativeGitHubToken(probeEnv, false, host);
  const [probe, author] = await Promise.all([
    token
      ? verifyGitHubCredential(token, { ...(managed ? {} : { apiBaseUrl }), allowStale: true })
      : undefined,
    readGitAuthor(probeEnv, params.cwd),
  ]);
  const account = probe?.status === "available" ? probe.account : null;
  const credentialState =
    probe?.status === "unavailable" || !probe
      ? managed
        ? "configured_unavailable"
        : "unavailable"
      : probe.status;
  const oauth =
    managed && identity.config.kind === "oauth"
      ? await inspectGitHubOAuthRecord(identity.config.profileId)
      : { state: "missing" as const };
  const oauthRecord = oauth.state === "valid" ? oauth.record : undefined;
  const refreshState =
    !managed || identity.config.kind !== "oauth"
      ? "not_applicable"
      : oauth.state !== "valid"
        ? "unavailable"
        : oauth.record.pendingRefresh
          ? "refreshing"
          : (oauth.record.refreshFailure ??
            (oauth.record.refreshExpiresAtMs <= Date.now() ? "expired" : "available"));
  return {
    source: identity.source,
    ...(probe?.status === "available" && probe.stale ? { stale: true } : {}),
    credentialKind: !managed
      ? "native"
      : identity.config.kind === "oauth"
        ? "managed-oauth"
        : "managed-pat",
    credentialState,
    account: account ? { login: account.login } : null,
    gitAuthor: author,
    evidence: account
      ? "github-api"
      : probe?.status === "rate_limited"
        ? "rate-limited"
        : probe
          ? "unverified"
          : "none",
    accessExpiresAtMs: oauthRecord?.accessExpiresAtMs ?? null,
    refreshState,
    oauthScopes: [...(oauthRecord?.scopes ?? [])],
    repositoryGrants: "unknown",
  };
}

/** Only the personal publication broker receives this environment; never agent execution. */
export async function preparePersonalGitHubPublicationIdentity(params: {
  profileId: string;
  accountId: number;
  assertCurrent: () => void;
  /** Display reads never use these facts to authorize publication. */
  forDisplay?: true;
}): Promise<PreparedGitHubPublicationIdentity> {
  params.assertCurrent();
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const assertSelected = () => {
    params.assertCurrent();
    if (resolveGitHubHost() !== host || resolveGitHubApiBaseUrl() !== apiBaseUrl) {
      throw new GitHubIdentityError("changed");
    }
  };
  const profileDir = resolveManagedGitHubProfileDir({
    agentId: "",
    scope: "personal",
    profileId: params.profileId,
  });
  const token = await readManagedGitHubToken(profileDir);
  if (!token) {
    throw new Error("My GitHub profile is unavailable; reconnect My GitHub.");
  }
  assertSelected();
  const env = {
    ...withGitHubToken(process.env, token),
    GH_CONFIG_DIR: profileDir,
    GH_PROMPT_DISABLED: "1",
  };
  const probe = await verifyGitHubCredential(token, { allowStale: params.forDisplay });
  assertSelected();
  if (probe.status !== "available") {
    throw new Error("My GitHub credential could not be verified; reconnect My GitHub.");
  }
  if (probe.account.accountId !== params.accountId) {
    throw new GitHubAccountMismatchError("My GitHub account changed; reconnect My GitHub.");
  }
  return Object.freeze({
    source: "personal",
    ...(probe.stale ? { stale: true as const } : {}),
    profileId: params.profileId,
    host: GITHUB_HOST,
    account: probe.account,
    env: Object.freeze(env),
  });
}

/** Confirms the current config still selects the prepared publication profile. */
export function matchesPreparedGitHubPublicationIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  const current = resolveGitHubToolIdentity(params);
  return (
    current.source === params.identity.source &&
    (params.identity.host ?? resolveGitHubHost()) === resolveGitHubHost() &&
    (current.source === "system-detected" || current.config.profileId === params.identity.profileId)
  );
}

async function prepareSharedGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    startCurrent?: GitHubReadIdentityStarter;
    allowAnonymous?: boolean;
    allowAppInstallation?: boolean;
    requestedRepository?: string;
    allowStale?: boolean;
  },
  identity: ResolvedGitHubToolIdentity,
  readNativeToken = readNativeGitHubToken,
  host = resolveGitHubHost(),
  apiBaseUrl = resolveGitHubApiBaseUrl(),
) {
  const managed = identity.source !== "system-detected";
  const readOAuth = () =>
    managed && identity.config.kind === "oauth"
      ? inspectGitHubOAuthRecord(identity.config.profileId)
      : undefined;
  const oauthAtStart = await startGitHubIdentityOperation(readOAuth, params);
  if (managed && identity.config.kind === "app-installation") {
    return await prepareAppGitHubIdentity(
      params,
      identity.config,
      identity.source,
      githubIdentityProbeEnvironment(params, identity),
      host,
      apiBaseUrl,
    );
  }
  const currentEnvironment = (): NodeJS.ProcessEnv => ({
    ...githubIdentityProbeEnvironment(params, identity),
    GH_PROMPT_DISABLED: "1",
  });
  if (managed && (host !== GITHUB_HOST || apiBaseUrl !== resolveConfiguredGitHubApiBaseUrl())) {
    const error = new GitHubIdentityError("unavailable");
    error.message =
      "Use a credential issued by the repository's GitHub host; managed profiles are issued by github.com.";
    throw error;
  }
  const readToken = () =>
    managed
      ? readManagedGitHubToken(identity.profileDir)
      : params.readNativeCredential
        ? params.readNativeCredential(currentEnvironment())
        : readNativeToken(currentEnvironment(), params.allowAnonymous === true, host);
  const token = await startGitHubIdentityOperation(readToken, params);
  if (!token) {
    return startGitHubIdentityOperation(() => {
      if (!managed && params.allowAnonymous) {
        return { prepared: undefined, token: undefined, readToken, stale: undefined };
      }
      throw new GitHubIdentityError("unavailable");
    }, params);
  }
  const probe = await startGitHubIdentityOperation(
    () => verifyGitHubCredential(token, { apiBaseUrl, allowStale: params.allowStale }),
    params,
  );
  return startGitHubIdentityOperation(async () => {
    if (probe.status !== "available") {
      throw new GitHubIdentityError(probe.status);
    }
    const oauth = await readOAuth();
    params.assertCurrent?.();
    const accessExpiresAtMs = resolveGitHubPublicationAccessExpiry(
      oauthAtStart,
      oauth,
      probe.account.accountId,
    );
    const prepared: Omit<PreparedGitHubPublicationIdentity, "env" | "source"> & {
      source: "system-detected" | "system-configured" | "agent-override";
      revoke?: () => Promise<void>;
    } = {
      source: identity.source,
      ...(managed ? { profileId: identity.config.profileId } : {}),
      host,
      account: probe.account,
      ...(accessExpiresAtMs !== undefined ? { accessExpiresAtMs } : {}),
    };
    return { prepared, token, readToken, ...(probe.stale ? { stale: true as const } : {}) };
  }, params);
}

/** Publication owns a fixed credential snapshot for its already-admitted operation. */
export async function prepareGitHubPublicationIdentity(
  params: GitHubIdentityPreparation & { assertCurrent?: () => void },
): Promise<PreparedGitHubPublicationIdentity> {
  const identity = resolveGitHubToolIdentity(params);
  // Capture the child environment before awaiting credentials; retirement cannot
  // redirect an already-admitted publication to another profile.
  const env = { ...githubIdentityProbeEnvironment(params, identity), GH_PROMPT_DISABLED: "1" };
  const { prepared, token } = await prepareSharedGitHubIdentity(params, identity);
  if (!prepared || token === undefined) {
    throw new GitHubIdentityError("unavailable");
  }
  return Object.freeze({ ...prepared, env: Object.freeze(withGitHubToken(env, token)) });
}

/** Options expose account facts only; publication obtains its own live credential. */
export async function prepareGitHubPublicationOptionsIdentity(
  params: GitHubIdentityPreparation & { assertCurrent?: () => void },
) {
  const selected = resolveGitHubToolIdentity(params);
  if (selected.source !== "system-detected" && selected.config.kind === "app-installation") {
    params.assertCurrent?.();
    return configuredAppGitHubOptionsIdentity(selected.config, selected.source);
  }
  let nativeStale = false;
  const { prepared, stale } = await prepareSharedGitHubIdentity(
    { ...params, allowStale: true },
    selected,
    (env, requireAbsentProof, host) =>
      readCachedNativeGitHubToken(env, requireAbsentProof, host, {
        onStale: () => {
          nativeStale = true;
        },
      }),
  );
  if (!prepared) {
    throw new GitHubIdentityError("unavailable");
  }
  return {
    source: prepared.source,
    account: prepared.account,
    ...(stale || nativeStale ? { stale: true as const } : {}),
  };
}

export function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation & { allowAnonymous: true },
): Promise<PreparedGitHubSourceReadIdentity>;
export function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation,
): Promise<PreparedGitHubReadIdentity>;
/** Read authority tracks current selection and token rotation, without exporting a child environment. */
export async function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation & { allowAnonymous?: boolean },
): Promise<PreparedGitHubSourceReadIdentity> {
  const selected = resolveGitHubToolIdentity(params);
  const { profileId, kind } = selected.source === "system-detected" ? {} : selected.config;
  const assertSelected = composeSessionSourceAssertion([
    captureExternalSessionCommitGuard(params.assertActive),
    () => {
      const current = resolveGitHubToolIdentity({ ...params, config: params.getCurrentConfig() });
      if (
        current.source !== selected.source ||
        (current.source !== "system-detected" &&
          (current.config.profileId !== profileId ||
            current.config.kind !== kind ||
            (kind === "app-installation" &&
              selected.source !== "system-detected" &&
              !isDeepStrictEqual(current.config, selected.config))))
      ) {
        throw new GitHubIdentityError("changed");
      }
    },
  ]);
  const caller = { assertCurrent: assertSelected, startCurrent: params.startActive };
  await startGitHubIdentityOperation(params.refresh, caller);
  assertSelected();
  const { token, readToken, prepared, stale } = await prepareSharedGitHubIdentity(
    { ...params, ...caller },
    selected,
    readCachedNativeGitHubToken,
    params.issuer,
    params.issuer ? resolveConfiguredGitHubApiBaseUrl() : undefined,
  );
  try {
    assertSelected();
  } catch (error) {
    await prepared?.revoke?.();
    throw error;
  }
  return {
    ...createGitHubReadIdentity({
      assertSelected,
      startActive: params.startActive,
      readToken,
      ...(stale ? { stale } : {}),
      ...(!prepared || token === undefined
        ? { token: undefined, selection: { source: "anonymous" as const } }
        : {
            token,
            selection: {
              source: selected.source,
              ...(profileId ? { profileId } : {}),
              accountId: prepared.account.accountId,
            },
          }),
    }),
    ...(prepared?.revoke ? { revoke: prepared.revoke } : {}),
  };
}

export async function removeManagedGitHubProfile(profileDir: string): Promise<void> {
  await fs.rm(profileDir, { recursive: true, force: true });
  clearNativeGitHubTokenCache();
  notifyManagedGitHubProfileChanged({ profileDir, kind: "removed" });
}

async function verifyManagedGitHubCredential(token: string) {
  const credential = normalizeManagedGitHubToken(token);
  const verified = await verifyGitHubCredential(credential);
  if (verified.status !== "available") {
    throw new Error("GitHub could not verify the managed credential.");
  }
  // Match gh's classic-token minimum scopes; other token types omit X-OAuth-Scopes.
  const scopes = verified.scopes;
  if (
    scopes.length &&
    (!scopes.includes("repo") ||
      !["read:org", "write:org", "admin:org"].some((scope) => scopes.includes(scope)))
  ) {
    throw new Error("GitHub credential is missing required repo or read:org scopes.");
  }
  return { account: verified.account, credential };
}

/** Verifies a rotated token, then atomically replaces credentials in one stable profile. */
export async function refreshManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  expectedAccountId: number;
  assertCurrent?: () => void;
  prepareEffect?: () => Promise<void>;
}): Promise<GitHubToolAccount> {
  if (!(await isPrivateManagedGitHubProfile(params.profileDir))) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const { account, credential } = await verifyManagedGitHubCredential(params.token);
  params.assertCurrent?.();
  if (account.accountId !== params.expectedAccountId) {
    throw new GitHubAccountMismatchError("GitHub OAuth refresh returned a different account.");
  }
  const targetHosts = path.join(params.profileDir, "hosts.yml");
  const targetStat = await fs.lstat(targetHosts);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const profile = await fsRoot(params.profileDir);
  await params.prepareEffect?.();
  params.assertCurrent?.();
  await profile.write(
    "hosts.yml",
    managedGitHubHosts({ login: account.login, token: credential }),
    {
      mode: 0o600,
      mkdir: false,
      durable: false,
      mutationSymlinks: "reject",
      assertBeforeMutation: params.assertCurrent,
    },
  );
  clearNativeGitHubTokenCache();
  params.assertCurrent?.();
  notifyManagedGitHubProfileChanged({ profileDir: params.profileDir, kind: "updated" });
  return account;
}

/** Publishes a new inactive profile and switches config without retiring in-use generations. */
export async function installManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  commitConfig: (account: GitHubToolAccount) => Promise<void>;
  retainProfileOnCommitFailure?: boolean;
  assertCurrent?: () => void;
  prepareEffect?: () => Promise<void>;
}): Promise<GitHubToolAccount> {
  const parent = path.dirname(params.profileDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const stagingRoot = await fs.mkdtemp(path.join(parent, ".github-profile.staging-"));
  const stagedProfile = path.join(stagingRoot, "profile");
  let published = false;
  let committed = false;
  try {
    const { account, credential } = await verifyManagedGitHubCredential(params.token);
    await writeManagedGitHubProfileFiles(stagedProfile, {
      login: account.login,
      token: credential,
    });
    await params.prepareEffect?.();
    params.assertCurrent?.();
    await fs.rename(stagedProfile, params.profileDir);
    published = true;
    await params.prepareEffect?.();
    params.assertCurrent?.();
    await params.commitConfig(account);
    clearNativeGitHubTokenCache();
    committed = true;
    return account;
  } finally {
    if (published && !committed && !params.retainProfileOnCommitFailure) {
      await fs.rm(params.profileDir, { recursive: true, force: true });
    }
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
