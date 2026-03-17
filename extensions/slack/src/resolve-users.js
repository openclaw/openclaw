import { createSlackWebClient } from "./client.js";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries
} from "./resolve-allowlist-common.js";
function parseSlackUserInput(raw) {
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
async function listSlackUsers(client) {
  return collectSlackCursorItems({
    fetchPage: async (cursor) => await client.users.list({
      limit: 200,
      cursor
    }),
    collectPageItems: (res) => (res.members ?? []).map((member) => {
      const id = member.id?.trim();
      const name = member.name?.trim();
      if (!id || !name) {
        return null;
      }
      const profile = member.profile ?? {};
      return {
        id,
        name,
        displayName: profile.display_name?.trim() || void 0,
        realName: profile.real_name?.trim() || member.real_name?.trim() || void 0,
        email: profile.email?.trim()?.toLowerCase() || void 0,
        deleted: Boolean(member.deleted),
        isBot: Boolean(member.is_bot),
        isAppUser: Boolean(member.is_app_user)
      };
    }).filter(Boolean)
  });
}
function scoreSlackUser(user, match) {
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
    const candidates = [user.name, user.displayName, user.realName].map((value) => value?.toLowerCase()).filter(Boolean);
    if (candidates.some((value) => value === target)) {
      score += 2;
    }
  }
  return score;
}
function resolveSlackUserFromMatches(input, matches, parsed) {
  const scored = matches.map((user) => ({ user, score: scoreSlackUser(user, parsed) })).toSorted((a, b) => b.score - a.score);
  const best = scored[0]?.user ?? matches[0];
  return {
    input,
    resolved: true,
    id: best.id,
    name: best.displayName ?? best.realName ?? best.name,
    email: best.email,
    deleted: best.deleted,
    isBot: best.isBot,
    note: matches.length > 1 ? "multiple matches; chose best" : void 0
  };
}
async function resolveSlackUserAllowlist(params) {
  const client = params.client ?? createSlackWebClient(params.token);
  const users = await listSlackUsers(client);
  return resolveSlackAllowlistEntries({
    entries: params.entries,
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
      isBot: match?.isBot
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
          const candidates = [user.name, user.displayName, user.realName].map((value) => value?.toLowerCase()).filter(Boolean);
          return candidates.includes(target);
        });
        if (matches.length > 0) {
          return resolveSlackUserFromMatches(input, matches, parsed);
        }
      }
      return void 0;
    },
    buildUnresolved: (input) => ({ input, resolved: false })
  });
}
export {
  resolveSlackUserAllowlist
};
