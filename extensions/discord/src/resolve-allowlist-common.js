import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";
function resolveDiscordAllowlistToken(token) {
  return normalizeDiscordToken(token, "channels.discord.token");
}
function buildDiscordUnresolvedResults(entries, buildResult) {
  return entries.map((input) => buildResult(input));
}
function findDiscordGuildByName(guilds, input) {
  const slug = normalizeDiscordSlug(input);
  if (!slug) {
    return void 0;
  }
  return guilds.find((guild) => guild.slug === slug);
}
function filterDiscordGuilds(guilds, params) {
  if (params.guildId) {
    return guilds.filter((guild) => guild.id === params.guildId);
  }
  if (params.guildName) {
    const match = findDiscordGuildByName(guilds, params.guildName);
    return match ? [match] : [];
  }
  return guilds;
}
export {
  buildDiscordUnresolvedResults,
  filterDiscordGuilds,
  findDiscordGuildByName,
  resolveDiscordAllowlistToken
};
