import { listSessionParticipantsReadOnly } from "../config/sessions/session-accessor.js";
import { MAX_SESSION_PARTICIPANTS } from "../config/sessions/session-entry-provenance.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserProfileGitHubAttribution } from "../state/user-profile-github-identity.js";
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
};

export function resolveGitCoauthorAttribution(params: {
  agentId: string;
  config: OpenClawConfig;
  excludeAccountId?: number;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): GitCoauthorAttribution | undefined {
  if (!params.sessionKey) {
    return undefined;
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
  const records =
    listSessionParticipantsReadOnly({
      agentId: params.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
      storePath,
    }).get(params.sessionKey) ?? [];
  const profileRecords = new Map(
    records.flatMap((record) =>
      record.identity.type === "profile" ? [[record.identity.id, record] as const] : [],
    ),
  );
  if (profileRecords.size === 0) {
    return undefined;
  }
  const identities = resolveUserProfileGitHubAttribution([...profileRecords.keys()], {
    env: params.env,
  });
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  const contributors = new Map<number, GitCoauthorContributor>();
  for (const [profileId, record] of profileRecords) {
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
      contributor.contributionCount += record.contributionCount;
      contributor.firstPromptedAt =
        contributor.firstPromptedAt === null || record.firstPromptedAt === null
          ? null
          : Math.min(contributor.firstPromptedAt, record.firstPromptedAt);
      continue;
    }
    contributors.set(identity.accountId, {
      accountId: identity.accountId,
      contributionCount: record.contributionCount,
      firstPromptedAt: record.firstPromptedAt,
      login: identity.login,
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
      left.accountId - right.accountId,
  );
  const visibleContributors = orderedContributors.slice(0, MAX_SESSION_PARTICIPANTS);
  const logins = visibleContributors.map(({ login }) => login);
  const trailers = visibleContributors.map(
    ({ accountId, login }) =>
      `Co-authored-by: ${login} <${accountId}+${login}@users.noreply.github.com>`,
  );
  return trailers.length ? { trailers, logins } : undefined;
}
