import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries,
} from "./resolve-allowlist-common.js";

export type SlackUserLookup = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
};

export type SlackUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  note?: string;
};

type SlackListUsersResponse = {
  members?: Array<{
    id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  }>;
  response_metadata?: { next_cursor?: string };
};

function parseSlackUserInput(raw: string): { id?: string; name?: string; email?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) {
    return { id: mention[1]?.toUpperCase() };
  }
  const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
  if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  if (trimmed.includes("@") && !trimmed.startsWith("@")) {
    return { email: trimmed.toLowerCase() };
  }
  const name = trimmed.replace(/^@/, "").trim();
  return name ? { name } : {};
}

async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  return collectSlackCursorItems({
    fetchPage: async (cursor) =>
      (await client.users.list({
        limit: 200,
        cursor,
      })) as SlackListUsersResponse,
    collectPageItems: (res) =>
      (res.members ?? [])
        .map((member) => {
          const id = member.id?.trim();
          const name = member.name?.trim();
          if (!id || !name) {
            return null;
          }
          const profile = member.profile ?? {};
          return {
            id,
            name,
            displayName: profile.display_name?.trim() || undefined,
            realName: profile.real_name?.trim() || member.real_name?.trim() || undefined,
            email: profile.email?.trim()?.toLowerCase() || undefined,
            deleted: Boolean(member.deleted),
            isBot: Boolean(member.is_bot),
            isAppUser: Boolean(member.is_app_user),
          } satisfies SlackUserLookup;
        })
        .filter(Boolean) as SlackUserLookup[],
  });
}

function scoreSlackUser(user: SlackUserLookup, match: { name?: string; email?: string }): number {
  let score = 0;
  if (!user.deleted) {
    score += 3;
  }
  if (!user.isBot && !user.isAppUser) {
    score += 2;
  }
  if (match.email && user.email === match.email) {
    score += 5;
  }
  if (match.name) {
    const target = match.name.toLowerCase();
    const candidates = [user.name, user.displayName, user.realName]
      .map((value) => value?.toLowerCase())
      .filter(Boolean) as string[];
    if (candidates.some((value) => value === target)) {
      score += 2;
    }
  }
  return score;
}

function resolveSlackUserFromMatches(
  input: string,
  matches: SlackUserLookup[],
  parsed: { name?: string; email?: string },
): SlackUserResolution {
  const scored = matches
    .map((user) => ({ user, score: scoreSlackUser(user, parsed) }))
    .toSorted((a, b) => b.score - a.score);
  const best = scored[0]?.user ?? matches[0];
  return {
    input,
    resolved: true,
    id: best.id,
    name: best.displayName ?? best.realName ?? best.name,
    email: best.email,
    deleted: best.deleted,
    isBot: best.isBot,
    note: matches.length > 1 ? "multiple matches; chose best" : undefined,
  };
}

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);

  // Partition entries: ID-based can use the cheaper users.info (Tier 4),
  // name/email-based still need users.list (Tier 2).
  const parsedEntries = params.entries.map((e, index) => ({
    input: e,
    parsed: parseSlackUserInput(e),
    index,
  }));
  const idEntries = parsedEntries.filter((e) => e.parsed.id);
  const nonIdEntries = parsedEntries.filter((e) => !e.parsed.id);

  // Resolve ID-based entries in batches to respect Slack's Tier 4 burst limits
  const BATCH_SIZE = 20;
  const idResults: SlackUserResolution[] = [];
  for (let i = 0; i < idEntries.length; i += BATCH_SIZE) {
    const batch = idEntries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ input, parsed }) => {
        try {
          const res = await client.users.info({ user: parsed.id! });
          const member = res.user as
            | {
                id?: string;
                name?: string;
                deleted?: boolean;
                is_bot?: boolean;
                is_app_user?: boolean;
                real_name?: string;
                profile?: { display_name?: string; real_name?: string; email?: string };
              }
            | undefined;
          if (!member?.id) {
            return { input, resolved: false, note: "users.info returned no user" };
          }
          const profile = member.profile ?? {};
          return {
            input,
            resolved: true,
            id: member.id,
            name:
              profile.display_name?.trim() ||
              profile.real_name?.trim() ||
              member.real_name?.trim() ||
              member.name?.trim(),
            email: profile.email?.trim()?.toLowerCase(),
            deleted: Boolean(member.deleted),
            isBot: Boolean(member.is_bot),
          };
        } catch (err) {
          // user_not_found / users_not_found is expected for deleted/deprovisioned users
          const code = (err as { data?: { error?: string } })?.data?.error;
          if (code !== "users_not_found" && code !== "user_not_found") {
            throw err;
          }
          return { input, resolved: false, note: "users.info lookup failed" };
        }
      }),
    );
    idResults.push(...batchResults);
  }

  // Only fetch the full user list if there are name/email-based entries
  let nonIdResults: SlackUserResolution[] = [];
  if (nonIdEntries.length > 0) {
    const users = await listSlackUsers(client);
    nonIdResults = resolveSlackAllowlistEntries<
      { id?: string; name?: string; email?: string },
      SlackUserLookup,
      SlackUserResolution
    >({
      entries: nonIdEntries.map((e) => e.input),
      lookup: users,
      parseInput: parseSlackUserInput,
      findById: (lookup, id) => lookup.find((user) => user.id === id),
      buildIdResolved: ({ input, parsed, match }) => ({
        input,
        resolved: true,
        id: parsed.id,
        name: match?.displayName ?? match?.realName ?? match?.name,
        email: match?.email,
        deleted: match?.deleted,
        isBot: match?.isBot,
      }),
      resolveNonId: ({ input, parsed, lookup }) => {
        if (parsed.email) {
          const matches = lookup.filter((user) => user.email === parsed.email);
          if (matches.length > 0) {
            return resolveSlackUserFromMatches(input, matches, parsed);
          }
        }
        if (parsed.name) {
          const target = parsed.name.toLowerCase();
          const matches = lookup.filter((user) => {
            const candidates = [user.name, user.displayName, user.realName]
              .map((value) => value?.toLowerCase())
              .filter(Boolean) as string[];
            return candidates.includes(target);
          });
          if (matches.length > 0) {
            return resolveSlackUserFromMatches(input, matches, parsed);
          }
        }
        return undefined;
      },
      buildUnresolved: (input) => ({ input, resolved: false }),
    });
  }

  // Reassemble results in the original input order using indices
  // (avoids Map key collisions when the same entry appears more than once)
  const results: SlackUserResolution[] = new Array(params.entries.length);
  for (let i = 0; i < idEntries.length; i++) {
    results[idEntries[i].index] = idResults[i];
  }
  for (let i = 0; i < nonIdEntries.length; i++) {
    results[nonIdEntries[i].index] = nonIdResults[i];
  }
  return results.map((r, i) => r ?? { input: params.entries[i], resolved: false });
}
