import { MAX_SESSION_PARTICIPANTS } from "../config/sessions/session-entry-provenance.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "../state/user-profile-github-identity.js";
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
  inheritedOrder?: number;
};

type GitCoauthorAttributionParams = {
  agentId: string;
  config: OpenClawConfig;
  excludeAccountId?: number;
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
  const prepared = retainAuthority
    ? await prepareUserProfileGitHubAttribution(profileIds, { env: params.env })
    : {
        identities: await resolveUserProfileGitHubAttribution(profileIds, { env: params.env }),
        isCurrent: () => true,
      };
  const identities = prepared.identities;
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  const contributors = new Map<number, GitCoauthorContributor>();
  for (const profileId of profileIds) {
    const record = profileRecords.get(profileId);
    const identity = identities.get(profileId);
    if (!identity) {
      continue;
    }
    if (identity.accountId === params.excludeAccountId) {
      continue;
    }
    const noreplyEmail = `${identity.accountId}+${identity.login}@users.noreply.github.com`;
    // An explicit publisher replaces the configured primary; the other account may deserve credit.
    if (params.excludeAccountId === undefined && noreplyEmail.toLowerCase() === primaryEmail) {
      continue;
    }
    const contributor = contributors.get(identity.accountId);
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
    contributors.set(identity.accountId, {
      accountId: identity.accountId,
      contributionCount: record?.contributionCount ?? 0,
      firstPromptedAt: record?.firstPromptedAt ?? null,
      login: identity.login,
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
    ({ accountId, login }) =>
      `Co-authored-by: ${login} <${accountId}+${login}@users.noreply.github.com>`,
  );
  return {
    attribution: trailers.length ? { trailers, logins } : undefined,
    isCurrent: prepared.isCurrent,
  };
}
