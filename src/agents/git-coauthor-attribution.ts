import {
  MAX_SESSION_PARTICIPANTS,
  isMainGitContributorScope,
  inheritSessionGitContributorProfileIds,
} from "../config/sessions/session-entry-provenance.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  GitCoauthorFormatInputV1,
  FormattedGitCoauthorV1,
} from "../plugins/execution-environment-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "../state/user-profile-github-identity.js";
import { formatGitHubCoauthor } from "./github-git-attribution.js";
import { resolveConfiguredGitHubHost } from "./github-host.js";

type GitCoauthorAttribution = { trailers: string[]; logins: string[] };

type GitCoauthorAttributionParams = {
  registry?: PluginRegistry;
  agentId: string;
  config: OpenClawConfig;
  excludeAccountId?: number;
  /** Host-verified requester; main is a routing hub, not a task contributor set. */
  requesterProfileId?: string;
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
  const formatters =
    (params.registry ?? getPluginRegistryForContext())?.executionEnvironments.filter(
      ({ provider }) => provider.formatGitCoauthor,
    ) ?? [];
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
  const source = {
    ...params,
    sessionKey: params.sessionKey,
    requesterProfileId: params.requesterProfileId,
  };
  const profileIds = isMainGitContributorScope(source)
    ? (inheritSessionGitContributorProfileIds(entry, source) ?? [])
    : [...new Set([...profileRecords.keys(), ...inheritedProfileIds])];
  if (profileIds.length === 0) {
    return empty;
  }
  const host = params.host ?? resolveConfiguredGitHubHost(params.config);
  const prepared = retainAuthority
    ? await prepareUserProfileGitHubAttribution(profileIds, { env: params.env, host })
    : {
        identities: await resolveUserProfileGitHubAttribution(profileIds, {
          env: params.env,
          host,
        }),
        isCurrent: () => true,
      };
  for (const provider of formatters) {
    provider.assertCurrent();
  }
  const contributors = new Map<
    number,
    {
      identity: GitCoauthorFormatInputV1["identity"];
      accountId: number;
      contributionCount: number;
      firstPromptedAt: number | null;
      inheritedOrder?: number;
    }
  >();
  for (const profileId of profileIds) {
    const identity = prepared.identities.get(profileId);
    if (!identity) {
      continue;
    }
    const issuer = "host" in identity ? identity.host : "github.com";
    if (issuer !== host) {
      continue;
    }
    const record = profileRecords.get(profileId);
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
      identity: {
        issuer,
        subject: String(identity.accountId),
        name: identity.login,
        ...("host" in identity && identity.verifiedEmail
          ? { verifiedEmail: identity.verifiedEmail }
          : {}),
      },
      accountId: identity.accountId,
      contributionCount: record?.contributionCount ?? 0,
      firstPromptedAt: record?.firstPromptedAt ?? null,
      ...(!record ? { inheritedOrder: inheritedProfileIds.indexOf(profileId) } : {}),
    });
  }
  const ordered = [...contributors.values()].toSorted(
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
  const usedFormatters = new Set<(typeof formatters)[number]>();
  const visible = ordered
    .flatMap(({ identity }) => {
      const input: GitCoauthorFormatInputV1 = {
        config: params.config,
        agentId: params.agentId,
        issuer: params.host,
        excludeSubject:
          params.excludeAccountId === undefined ? undefined : String(params.excludeAccountId),
        identity,
      };
      let formatted: FormattedGitCoauthorV1 | null | undefined;
      for (const formatterEntry of formatters) {
        formatterEntry.assertCurrent();
        const result = formatterEntry.provider.formatGitCoauthor?.(input);
        formatterEntry.assertCurrent();
        if (result !== undefined) {
          usedFormatters.add(formatterEntry);
          if (formatted !== undefined) {
            throw new Error(
              `Several execution providers format Git co-author issuer ${identity.issuer}.`,
            );
          }
          formatted = result;
        }
      }
      if (formatted === undefined) {
        formatted = formatGitHubCoauthor(input);
      }
      return formatted ? [formatted] : [];
    })
    .slice(0, MAX_SESSION_PARTICIPANTS);
  return {
    attribution: visible.length
      ? { trailers: visible.map(({ trailer }) => trailer), logins: visible.map(({ name }) => name) }
      : undefined,
    isCurrent() {
      if (!prepared.isCurrent()) {
        return false;
      }
      try {
        for (const formatterEntry of usedFormatters) {
          formatterEntry.assertCurrent();
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
