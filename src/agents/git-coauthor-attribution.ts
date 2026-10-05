import { MAX_SESSION_PARTICIPANTS } from "../config/sessions/session-entry-provenance.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "../state/user-profile-github-identity.js";
import { resolveConfiguredGitHubHost } from "./github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "./github-tool-identity.js";

type GitCoauthorAttribution = {
  trailers: string[];
  logins: string[];
};

type GitCoauthorContributor = {
  accountId: number;
  contributionCount: number;
  firstPromptedAt: number | null;
  login: string;
  email: string;
  inheritedOrder?: number;
};

type GitCoauthorAttributionParams = {
  agentId: string;
  config: OpenClawConfig;
  excludeIdentity?: { host: string; accountId: number };
  host?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
};

type PreparedGitCoauthorAttribution = {
  attribution: GitCoauthorAttribution | undefined;
  isCurrent: () => boolean;
};

export async function resolveGitCoauthorAttribution(
  params: GitCoauthorAttributionParams,
): Promise<GitCoauthorAttribution | undefined> {
  return (await resolveAttribution(params, false)).attribution;
}

export async function prepareGitCoauthorAttribution(
  params: GitCoauthorAttributionParams,
): Promise<PreparedGitCoauthorAttribution> {
  return await resolveAttribution(params, true);
}

async function resolveAttribution(
  params: GitCoauthorAttributionParams,
  retainAuthority: boolean,
): Promise<PreparedGitCoauthorAttribution> {
  const empty = { attribution: undefined, isCurrent: () => true };
  if (!params.sessionKey || isIncognitoSessionKey(params.sessionKey)) {
    return empty;
  }
  const storePath = resolveSessionStorePathForScope(
    {
      agentId: params.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.config,
  );
  const read = await readSessionEntriesFromStoreInWorker({
    agentId: params.agentId,
    env: params.env,
    sessionKeys: [params.sessionKey],
    storePath,
    includeParticipantRecords: true,
    snapshotFields: [],
  });
  const entry = read.entries.find(({ sessionKey }) => sessionKey === params.sessionKey)?.entry;
  if (!entry || entry.incognito || (params.sessionId && entry.sessionId !== params.sessionId)) {
    return empty;
  }
  const records = read.participantRecords?.[params.sessionKey] ?? [];
  const profileRecords = new Map(
    records.flatMap((record) =>
      record.identity.type === "profile" ? [[record.identity.id, record] as const] : [],
    ),
  );
  const inheritedProfileIds = entry.inheritedGitContributorProfileIds ?? [];
  const profileIds = [...new Set([...profileRecords.keys(), ...inheritedProfileIds])];
  if (profileIds.length === 0) {
    return empty;
  }
  const host = params.host ?? resolveConfiguredGitHubHost(params.config);
  const prepared = retainAuthority
    ? await prepareUserProfileGitHubAttribution(profileIds, {
        env: params.env,
        host,
      })
    : {
        identities: await resolveUserProfileGitHubAttribution(profileIds, {
          env: params.env,
          host,
        }),
        isCurrent: () => true,
      };
  const identities = prepared.identities;
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  const contributors = new Map<string, GitCoauthorContributor>();
  for (const profileId of profileIds) {
    const record = profileRecords.get(profileId);
    const identity = identities.get(profileId);
    if (!identity) {
      continue;
    }
    const issuer = "host" in identity ? identity.host : "github.com";
    if (
      issuer !== host ||
      (params.excludeIdentity !== undefined &&
        identity.accountId === params.excludeIdentity.accountId &&
        issuer === params.excludeIdentity.host)
    ) {
      continue;
    }
    const email =
      "verifiedEmail" in identity
        ? identity.verifiedEmail
        : `${identity.accountId}+${identity.login}@users.noreply.github.com`;
    // An explicit publisher replaces the configured primary; the other account may deserve credit.
    if (params.excludeIdentity === undefined && email.toLowerCase() === primaryEmail) {
      continue;
    }
    const identityKey = `${issuer}:${identity.accountId}`;
    const contributor = contributors.get(identityKey);
    if (contributor) {
      if (record) {
        contributor.contributionCount += record.contributionCount;
        contributor.firstPromptedAt =
          contributor.firstPromptedAt === null || record.firstPromptedAt === null
            ? null
            : Math.min(contributor.firstPromptedAt, record.firstPromptedAt);
      }
      continue;
    }
    contributors.set(identityKey, {
      accountId: identity.accountId,
      contributionCount: record?.contributionCount ?? 0,
      firstPromptedAt: record?.firstPromptedAt ?? null,
      login: identity.login,
      email,
      ...(!record ? { inheritedOrder: inheritedProfileIds.indexOf(profileId) } : {}),
    });
  }

  const orderedContributors = [...contributors.values()].toSorted(
    (left, right) =>
      right.contributionCount - left.contributionCount ||
      (left.firstPromptedAt === null
        ? right.firstPromptedAt === null
          ? 0
          : 1
        : right.firstPromptedAt === null
          ? -1
          : left.firstPromptedAt - right.firstPromptedAt) ||
      (left.inheritedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.inheritedOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.accountId - right.accountId,
  );
  const visibleContributors = orderedContributors.slice(0, MAX_SESSION_PARTICIPANTS);
  const logins = visibleContributors.map(({ login }) => login);
  const trailers = visibleContributors.map(
    ({ email, login }) => `Co-authored-by: ${login} <${email}>`,
  );
  return {
    attribution: trailers.length ? { trailers, logins } : undefined,
    isCurrent: prepared.isCurrent,
  };
}
