import { fetchDiscord } from "./api.js";
import { listGuilds } from "./guilds.js";
import {
  buildDiscordUnresolvedResults,
  filterDiscordGuilds,
  resolveDiscordAllowlistToken
} from "./resolve-allowlist-common.js";
function parseDiscordUserInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  if (mention) {
    return { userId: mention[1] };
  }
  const prefixed = trimmed.match(/^(?:user:|discord:)?(\d+)$/i);
  if (prefixed) {
    return { userId: prefixed[1] };
  }
  const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
  if (split.length >= 2) {
    const guild = split[0]?.trim();
    const user = split.slice(1).join("#").trim();
    if (guild && /^\d+$/.test(guild)) {
      return { guildId: guild, userName: user };
    }
    return { guildName: guild, userName: user };
  }
  return { userName: trimmed.replace(/^@/, "") };
}
function scoreDiscordMember(member, query) {
  const q = query.toLowerCase();
  const user = member.user;
  const candidates = [user.username, user.global_name, member.nick ?? void 0].map((value) => value?.toLowerCase()).filter(Boolean);
  let score = 0;
  if (candidates.some((value) => value === q)) {
    score += 3;
  }
  if (candidates.some((value) => value?.includes(q))) {
    score += 1;
  }
  if (!user.bot) {
    score += 1;
  }
  return score;
}
async function resolveDiscordUserAllowlist(params) {
  const token = resolveDiscordAllowlistToken(params.token);
  if (!token) {
    return buildDiscordUnresolvedResults(params.entries, (input) => ({
      input,
      resolved: false
    }));
  }
  const fetcher = params.fetcher ?? fetch;
  let guilds = null;
  const getGuilds = async () => {
    if (!guilds) {
      guilds = await listGuilds(token, fetcher);
    }
    return guilds;
  };
  const results = [];
  for (const input of params.entries) {
    const parsed = parseDiscordUserInput(input);
    if (parsed.userId) {
      results.push({
        input,
        resolved: true,
        id: parsed.userId
      });
      continue;
    }
    const query = parsed.userName?.trim();
    if (!query) {
      results.push({ input, resolved: false });
      continue;
    }
    const allGuilds = await getGuilds();
    const guildList = filterDiscordGuilds(allGuilds, {
      guildId: parsed.guildId,
      guildName: parsed.guildName?.trim()
    });
    let best = null;
    let matches = 0;
    for (const guild of guildList) {
      const paramsObj = new URLSearchParams({
        query,
        limit: "25"
      });
      const members = await fetchDiscord(
        `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
        token,
        fetcher
      );
      for (const member of members) {
        const score = scoreDiscordMember(member, query);
        if (score === 0) {
          continue;
        }
        matches += 1;
        if (!best || score > best.score) {
          best = { member, guild, score };
        }
      }
    }
    if (best) {
      const user = best.member.user;
      const name = best.member.nick?.trim() || user.global_name?.trim() || user.username?.trim() || void 0;
      results.push({
        input,
        resolved: true,
        id: user.id,
        name,
        guildId: best.guild.id,
        guildName: best.guild.name,
        note: matches > 1 ? "multiple matches; chose best" : void 0
      });
    } else {
      results.push({ input, resolved: false });
    }
  }
  return results;
}
export {
  resolveDiscordUserAllowlist
};
