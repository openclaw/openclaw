import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitLabToolIdentityConfig } from "../config/types.tools.js";
import { updateGitLabToolIdentityConfig } from "../gateway/gitlab-tool-identity-config.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import { subscribeSecretStoreChanges } from "../secrets/store/secret-store-changes.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  type AgentLifecycleBinding,
} from "./agent-lifecycle-registry.js";
import {
  normalizeGitLabIssuer,
  validateGitLabOAuthConfig,
  type GitLabOAuthConfig,
} from "./gitlab-host.js";
import {
  createGitLabManagedOAuthRecord,
  createManagedGitLabProfileId,
  deleteGitLabManagedOAuthRecord,
  inspectGitLabManagedOAuthRecord,
  writeGitLabManagedOAuthRecord,
  type GitLabManagedOAuthRecord,
  type GitLabIdentityScope,
} from "./gitlab-managed-records.js";
import {
  refreshGitLabAuthorization,
  verifyGitLabAccount,
  type GitLabAccount,
} from "./gitlab-oauth-client.js";
import { prepareGitLabToolEnvironment } from "./gitlab-tool-environment.js";
import {
  notifyManagedGitLabProfileChanged,
  onManagedGitLabProfileChanged,
} from "./gitlab-tool-identity-lifecycle.js";
import {
  resolveConfiguredGitLabToolIdentity,
  resolveEffectiveGitLabToolIdentity,
  resolveManagedGitLabProfileDir,
} from "./gitlab-tool-identity-selection.js";
import {
  readManagedGitLabProfileToken,
  writeManagedGitLabProfileFiles,
} from "./gitlab-tool-profile-files.js";
export {
  resolveConfiguredGitLabToolIdentity,
  resolveEffectiveGitLabToolIdentity,
  resolveManagedGitLabProfileDir,
} from "./gitlab-tool-identity-selection.js";

export { prepareGitLabToolEnvironment } from "./gitlab-tool-environment.js";

const refreshFlights = new Map<string, Promise<void>>();

export { onManagedGitLabProfileChanged } from "./gitlab-tool-identity-lifecycle.js";

function profileFileSignature(profileDir: string): string {
  return [profileDir, path.join(profileDir, "config.yml")]
    .map((pathname) => {
      const stat = fsSync.lstatSync(pathname, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error("Managed GitLab CLI profile changed.");
      }
      return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    })
    .join("|");
}

async function ensureManagedGitLabProfileFresh(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  scope: GitLabIdentityScope;
  agentId: string;
  identity: GitLabToolIdentityConfig;
  oauthConfig: GitLabOAuthConfig;
  assertCurrent?: () => void | Promise<void>;
}) {
  await refreshFlights.get(params.identity.profileId);
  let inspected = await inspectGitLabManagedOAuthRecord(params.identity.profileId);
  if (
    inspected.state === "valid" &&
    selectedRecord(inspected.record, params.identity, params.scope, params.agentId) &&
    inspected.record.tokens.expiresAtMs <= Date.now() + 60_000
  ) {
    const key = params.identity.profileId;
    let flight = refreshFlights.get(key);
    if (!flight) {
      flight = refreshManagedGitLabProfile(params)
        .then(() => undefined)
        .finally(() => refreshFlights.delete(key));
      refreshFlights.set(key, flight);
    }
    await flight;
    inspected = await inspectGitLabManagedOAuthRecord(key);
  }
  return inspected;
}

function sameActor(left: GitLabAccount, right: GitLabAccount): boolean {
  return (
    left.accountId === right.accountId &&
    left.login === right.login &&
    left.name === right.name &&
    left.commitEmail === right.commitEmail &&
    left.issuer === right.issuer
  );
}
function selectedRecord(
  record: GitLabManagedOAuthRecord,
  identity: GitLabToolIdentityConfig,
  scope: GitLabIdentityScope,
  agentId: string,
) {
  return (
    record.profileId === identity.profileId &&
    record.issuer === identity.issuer &&
    record.scope === scope &&
    (scope === "system" || record.agentId === agentId) &&
    !record.pendingInitial &&
    !record.refreshClaim &&
    !record.refreshFailure
  );
}

/** A selected profile has no native/user fallback; verification binds the live GitLab actor. */
export async function prepareGitLabToolCredential(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  agentId: string;
  oauthConfig: GitLabOAuthConfig;
  assertCurrent?: () => void | Promise<void>;
  assertCurrentSync?: () => void;
  env?: NodeJS.ProcessEnv;
}) {
  const selected = resolveEffectiveGitLabToolIdentity(params);
  if (!selected) {
    throw new Error("Select a managed GitLab identity before running glab.");
  }
  const oauth = validateGitLabOAuthConfig(params.oauthConfig);
  if (oauth.issuer !== normalizeGitLabIssuer(selected.identity.issuer)) {
    throw new Error("Managed GitLab issuer changed.");
  }
  const inspected = await ensureManagedGitLabProfileFresh({
    config: params.config,
    getCurrentConfig: params.getCurrentConfig,
    scope: selected.scope,
    agentId: params.agentId,
    identity: selected.identity,
    oauthConfig: oauth,
    assertCurrent: params.assertCurrent,
  });
  if (
    inspected.state !== "valid" ||
    !selectedRecord(inspected.record, selected.identity, selected.scope, params.agentId) ||
    inspected.record.tokens.expiresAtMs <= Date.now()
  ) {
    throw new Error("Managed GitLab credential is unavailable; reconnect this identity.");
  }
  const record = inspected.record;
  const profileDir = resolveManagedGitLabProfileDir({
    ...params,
    scope: selected.scope,
    profileId: record.profileId,
  });
  const source = captureOpenClawStateReadContext();
  const databasePath = normalizeDatabasePath(source.admission.databasePath);
  const fileSignature = profileFileSignature(profileDir);
  let revoked = false;
  const unsubscribeStore = subscribeSecretStoreChanges((change) => {
    if (change.databasePath === databasePath && change.gitlabManagedOAuth) {
      revoked = true;
    }
  });
  const unsubscribeProfile = onManagedGitLabProfileChanged((change) => {
    if (change.profileDir === profileDir) {
      revoked = true;
    }
  });
  const close = () => {
    revoked = true;
    unsubscribeStore();
    unsubscribeProfile();
  };
  const assertCurrentSync = () => {
    if (revoked) {
      throw new Error("Managed GitLab credential changed.");
    }
    params.assertCurrentSync?.();
    (source.assertPublicationCurrent ?? source.admission.assertCurrent)();
    const current = resolveEffectiveGitLabToolIdentity({
      config: params.getCurrentConfig(),
      agentId: params.agentId,
    });
    if (
      !current ||
      current.source !== selected.source ||
      current.scope !== selected.scope ||
      !isDeepStrictEqual(current.identity, selected.identity)
    ) {
      throw new Error("Managed GitLab selection changed.");
    }
    if (record.tokens.expiresAtMs <= Date.now()) {
      throw new Error("Managed GitLab credential expired.");
    }
    if (profileFileSignature(profileDir) !== fileSignature) {
      throw new Error("Managed GitLab CLI profile changed.");
    }
  };
  const assertCurrent = async () => {
    assertCurrentSync();
    await params.assertCurrent?.();
    const latest = await inspectGitLabManagedOAuthRecord(record.profileId);
    if (
      latest.state !== "valid" ||
      !isDeepStrictEqual(latest.record, record) ||
      !selectedRecord(latest.record, selected.identity, selected.scope, params.agentId) ||
      latest.record.tokens.expiresAtMs <= Date.now()
    ) {
      throw new Error("Managed GitLab credential changed or expired.");
    }
    if (
      (await readManagedGitLabProfileToken(profileDir, record.issuer)) !== record.tokens.accessToken
    ) {
      throw new Error("Managed GitLab CLI profile changed; reconnect this identity.");
    }
    assertCurrentSync();
  };
  let actor: GitLabAccount;
  try {
    await assertCurrent();
    actor = await verifyGitLabAccount(oauth, record.tokens, { assertCurrent, allowBot: true });
    await assertCurrent();
    if (!sameActor(actor, record.account)) {
      throw new Error("Managed GitLab actor changed; reconnect this identity.");
    }
    await assertCurrent();
  } catch (error) {
    close();
    throw error;
  }
  const scrub = prepareGitLabToolEnvironment(params);
  const env: NodeJS.ProcessEnv = { ...(params.env ?? process.env) };
  for (const key of Object.keys(scrub.credentialScrubEnv)) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (
      /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)$/u.test(key) ||
      /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/u.test(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, scrub.localIdentityEnv, {
    GITLAB_HOST: new URL(record.issuer).host,
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: actor.name,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: actor.commitEmail,
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_AUTHOR_NAME: actor.name,
    GIT_COMMITTER_NAME: actor.name,
    GIT_AUTHOR_EMAIL: actor.commitEmail,
    GIT_COMMITTER_EMAIL: actor.commitEmail,
    GIT_TERMINAL_PROMPT: "0",
  });
  return Object.freeze({
    source: selected.source,
    account: actor,
    profileId: record.profileId,
    issuer: record.issuer,
    env: Object.freeze(env),
    assertCurrent,
    assertCurrentSync,
    close,
    withToken: async <T>(run: (token: string) => Promise<T>): Promise<T> => {
      await assertCurrent();
      const result = await run(record.tokens.accessToken);
      await assertCurrent();
      return result;
    },
  });
}

export async function resolveGitLabToolIdentityStatus(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  agentId: string;
  selectedScope: GitLabIdentityScope;
  oauthConfig: GitLabOAuthConfig;
  assertCurrent?: () => void | Promise<void>;
}) {
  const selected = resolveConfiguredGitLabToolIdentity({ ...params, scope: params.selectedScope });
  const effective = resolveEffectiveGitLabToolIdentity(params);
  if (!selected) {
    return {
      selectedScope: params.selectedScope,
      selected: null,
      effectiveSource: effective?.source ?? "unavailable",
    };
  }
  let inspected: Awaited<ReturnType<typeof inspectGitLabManagedOAuthRecord>>;
  try {
    inspected = await ensureManagedGitLabProfileFresh({
      config: params.config,
      getCurrentConfig: params.getCurrentConfig,
      scope: params.selectedScope,
      agentId: params.agentId,
      identity: selected,
      oauthConfig: params.oauthConfig,
      assertCurrent: params.assertCurrent,
    });
  } catch {
    inspected = await inspectGitLabManagedOAuthRecord(selected.profileId);
  }
  const record = inspected.state === "valid" ? inspected.record : undefined;
  let credentialState: "available" | "unavailable" = "unavailable";
  let account: GitLabAccount | null = null;
  if (
    record &&
    selectedRecord(record, selected, params.selectedScope, params.agentId) &&
    record.tokens.expiresAtMs > Date.now()
  ) {
    try {
      const oauth = validateGitLabOAuthConfig(params.oauthConfig);
      if (oauth.issuer !== selected.issuer) {
        throw new Error("GitLab issuer changed.");
      }
      await params.assertCurrent?.();
      const actor = await verifyGitLabAccount(oauth, record.tokens, { allowBot: true });
      await params.assertCurrent?.();
      const profileToken = await readManagedGitLabProfileToken(
        resolveManagedGitLabProfileDir({
          scope: params.selectedScope,
          agentId: params.agentId,
          profileId: selected.profileId,
        }),
        selected.issuer,
      );
      if (
        !isDeepStrictEqual(
          resolveConfiguredGitLabToolIdentity({
            config: params.getCurrentConfig(),
            agentId: params.agentId,
            scope: params.selectedScope,
          }),
          selected,
        ) ||
        !sameActor(actor, record.account) ||
        profileToken !== record.tokens.accessToken
      ) {
        throw new Error("Managed GitLab identity changed.");
      }
      account = actor;
      credentialState = "available";
    } catch {
      /* Status is deliberately non-authorizing. */
    }
  }
  return {
    selectedScope: params.selectedScope,
    selected: {
      configured: true,
      profileId: selected.profileId,
      issuer: selected.issuer,
      credentialState,
      account,
      accessExpiresAtMs: record?.tokens.expiresAtMs ?? null,
      refreshState: record?.refreshClaim
        ? "reconnect_required"
        : (record?.refreshFailure ??
          (record
            ? record.tokens.expiresAtMs <= Date.now()
              ? "expired"
              : "available"
            : "unavailable")),
    },
    effectiveSource: effective?.source ?? "unavailable",
  };
}

/** Persist an inactive record first; only the caller's exact config CAS activates it. */
export async function installManagedGitLabProfile(params: {
  scope: GitLabIdentityScope;
  agentId: string;
  account: GitLabAccount;
  tokens: GitLabManagedOAuthRecord["tokens"];
  oauthConfig: GitLabOAuthConfig;
  requestId: string;
  expectedIdentity: GitLabToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
  commitConfig: (identity: GitLabToolIdentityConfig) => Promise<void>;
  assertCurrent?: () => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}) {
  await params.assertCurrent?.();
  if (params.scope === "agent" && params.agentLifecycleBinding?.agentId !== params.agentId) {
    throw new Error("Managed GitLab agent lifecycle binding is required.");
  }
  const oauth = validateGitLabOAuthConfig(params.oauthConfig);
  if (oauth.issuer !== params.account.issuer) {
    throw new Error("Managed GitLab issuer changed.");
  }
  const verified = await verifyGitLabAccount(oauth, params.tokens, {
    assertCurrent: params.assertCurrent,
    allowBot: true,
  });
  if (!sameActor(verified, params.account)) {
    throw new Error("Managed GitLab actor changed before installation.");
  }
  await params.assertCurrent?.();
  const profileId = createManagedGitLabProfileId();
  const record = createGitLabManagedOAuthRecord({
    profileId,
    scope: params.scope,
    agentId: params.agentId,
    account: params.account,
    tokens: params.tokens,
    pendingInitial: {
      requestId: params.requestId,
      expectedIdentity: params.expectedIdentity,
      ...(params.agentLifecycleBinding
        ? { agentLifecycleBinding: params.agentLifecycleBinding }
        : {}),
    },
  });
  await writeGitLabManagedOAuthRecord(record);
  await params.assertCurrent?.();
  const profileDir = resolveManagedGitLabProfileDir({ ...params, profileId });
  await writeManagedGitLabProfileFiles(profileDir, {
    issuer: params.account.issuer,
    login: params.account.login,
    token: params.tokens.accessToken,
  });
  await params.assertCurrent?.();
  await params.commitConfig({ profileId, issuer: params.account.issuer });
  await params.assertCurrent?.();
  await writeGitLabManagedOAuthRecord({ ...record, pendingInitial: undefined }, record);
  return { profileId, account: params.account };
}

/** Recovers an activation whose config committed before pending-initial settlement. */
export async function finishPendingManagedGitLabProfile(params: {
  getCurrentConfig: () => OpenClawConfig;
  scope: GitLabIdentityScope;
  agentId: string;
  profileId: string;
  assertCurrent?: () => void | Promise<void>;
}) {
  await params.assertCurrent?.();
  const inspected = await inspectGitLabManagedOAuthRecord(params.profileId);
  if (inspected.state !== "valid" || !inspected.record.pendingInitial) {
    throw new Error("No pending GitLab activation.");
  }
  const record = inspected.record;
  const pendingInitial = record.pendingInitial;
  if (!pendingInitial) {
    throw new Error("No pending GitLab activation.");
  }
  const config = params.getCurrentConfig();
  const selected = resolveConfiguredGitLabToolIdentity({
    config,
    scope: params.scope,
    agentId: params.agentId,
  });
  if (
    !selected ||
    selected.profileId !== record.profileId ||
    selected.issuer !== record.issuer ||
    record.scope !== params.scope ||
    record.agentId !== params.agentId
  ) {
    throw new Error("GitLab activation target changed.");
  }
  if (params.scope === "agent") {
    const binding = pendingInitial.agentLifecycleBinding;
    if (
      !binding ||
      !(await matchesAgentLifecycleBindingAsync(() => params.getCurrentConfig(), binding)) ||
      !matchesAgentLifecycleBinding(params.getCurrentConfig(), binding)
    ) {
      throw new Error("Managed GitLab agent changed before activation.");
    }
  }
  if (record.tokens.expiresAtMs <= Date.now()) {
    throw new Error("Managed GitLab activation expired.");
  }
  const profileDir = resolveManagedGitLabProfileDir({ ...params, profileId: record.profileId });
  if (
    (await readManagedGitLabProfileToken(profileDir, record.issuer)) !== record.tokens.accessToken
  ) {
    throw new Error("Managed GitLab CLI profile changed before activation.");
  }
  await params.assertCurrent?.();
  await writeGitLabManagedOAuthRecord({ ...record, pendingInitial: undefined }, record);
}

/** Clean one unselected profile without reading or touching another principal's custody. */
export async function removeManagedGitLabProfile(params: {
  scope: GitLabIdentityScope;
  agentId: string;
  profileId: string;
  getCurrentConfig: () => OpenClawConfig;
  assertCurrent?: () => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const assertUnselected = async () => {
    await params.assertCurrent?.();
    const current = params.getCurrentConfig();
    if (
      current.tools?.gitlab?.profileId === params.profileId ||
      Object.values(current.agents?.entries ?? {}).some(
        (entry) => entry.tools?.gitlab?.profileId === params.profileId,
      )
    ) {
      throw new Error("Managed GitLab profile is still selected.");
    }
  };
  await assertUnselected();
  const dir = resolveManagedGitLabProfileDir(params);
  const inspected = await inspectGitLabManagedOAuthRecord(params.profileId);
  if (
    inspected.state === "valid" &&
    (inspected.record.scope !== params.scope || inspected.record.agentId !== params.agentId)
  ) {
    throw new Error("Managed GitLab profile custody changed.");
  }
  await assertUnselected();
  await fs.rm(dir, { recursive: true, force: true });
  notifyManagedGitLabProfileChanged({ profileDir: dir, kind: "removed" });
  await assertUnselected();
  await deleteGitLabManagedOAuthRecord(params.profileId);
}

/** Clearing the selected config revokes use before hidden credential cleanup. */
export async function retireManagedGitLabProfile(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  scope: GitLabIdentityScope;
  agentId: string;
  assertCurrent?: () => void | Promise<void>;
  agentLifecycleBinding?: AgentLifecycleBinding;
}) {
  const selected = resolveConfiguredGitLabToolIdentity(params);
  if (!selected) {
    return { retired: false };
  }
  await updateGitLabToolIdentityConfig({
    scope: params.scope,
    agentId: params.agentId,
    expectedIdentity: selected,
    agentLifecycleBinding: params.agentLifecycleBinding,
    assertCurrent: params.assertCurrent,
  });
  try {
    await removeManagedGitLabProfile({
      scope: params.scope,
      agentId: params.agentId,
      profileId: selected.profileId,
      getCurrentConfig: params.getCurrentConfig,
      assertCurrent: params.assertCurrent,
    });
    return { retired: true, cleanupPending: false };
  } catch {
    // Config removal is already durable. The managed lifecycle retries cleanup once
    // neither persisted nor runtime config references this profile.
    await params.assertCurrent?.();
    return { retired: true, cleanupPending: true };
  }
}

/** A durable claim precedes the provider call; uncertain refresh never replays a rotating token. */
export async function refreshManagedGitLabProfile(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  scope: GitLabIdentityScope;
  agentId: string;
  oauthConfig: GitLabOAuthConfig;
  assertCurrent?: () => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}) {
  const identity = resolveConfiguredGitLabToolIdentity(params);
  if (!identity) {
    throw new Error("Managed GitLab identity is not selected.");
  }
  const oauth = validateGitLabOAuthConfig(params.oauthConfig);
  if (oauth.issuer !== identity.issuer) {
    throw new Error("Managed GitLab issuer changed.");
  }
  const inspected = await inspectGitLabManagedOAuthRecord(identity.profileId);
  if (
    inspected.state !== "valid" ||
    !selectedRecord(inspected.record, identity, params.scope, params.agentId)
  ) {
    throw new Error("Managed GitLab refresh is unavailable; reconnect this identity.");
  }
  const current = inspected.record;
  const assertSelected = async () => {
    await params.assertCurrent?.();
    if (
      !isDeepStrictEqual(
        resolveConfiguredGitLabToolIdentity({
          config: params.getCurrentConfig(),
          scope: params.scope,
          agentId: params.agentId,
        }),
        identity,
      )
    ) {
      throw new Error("Managed GitLab selection changed.");
    }
  };
  await assertSelected();
  const claimed = { ...current, refreshClaim: randomUUID() };
  await writeGitLabManagedOAuthRecord(claimed, current);
  const assertClaim = async () => {
    await assertSelected();
    const latest = await inspectGitLabManagedOAuthRecord(identity.profileId);
    if (latest.state !== "valid" || !isDeepStrictEqual(latest.record, claimed)) {
      throw new Error("Managed GitLab refresh claim changed.");
    }
  };
  try {
    const tokens = await refreshGitLabAuthorization(oauth, {
      refreshToken: current.tokens.refreshToken,
      assertCurrent: assertClaim,
    });
    const actor = await verifyGitLabAccount(oauth, tokens, {
      assertCurrent: assertClaim,
      allowBot: true,
    });
    if (!sameActor(actor, current.account)) {
      throw new Error("GitLab refresh returned a different actor.");
    }
    await assertClaim();
    const next = { ...claimed, tokens, refreshClaim: undefined };
    const profileDir = resolveManagedGitLabProfileDir({ ...params, profileId: identity.profileId });
    await assertClaim();
    await writeManagedGitLabProfileFiles(
      profileDir,
      { issuer: identity.issuer, login: actor.login, token: tokens.accessToken },
      {
        assertCurrent: () => {
          if (
            !isDeepStrictEqual(
              resolveConfiguredGitLabToolIdentity({
                config: params.getCurrentConfig(),
                scope: params.scope,
                agentId: params.agentId,
              }),
              identity,
            )
          ) {
            throw new Error("Managed GitLab selection changed.");
          }
        },
      },
    );
    await assertClaim();
    await writeGitLabManagedOAuthRecord(next, claimed);
    return actor;
  } catch {
    // Once dispatched, refresh-token rotation may have occurred. Keep the claim
    // until an operator reconnects; repeating the old token would be unsafe.
    throw new Error("Managed GitLab refresh could not be confirmed; reconnect this identity.");
  }
}
