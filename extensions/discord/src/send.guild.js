import { Routes } from "discord-api-types/v10";
import { resolveDiscordRest } from "./send.shared.js";
async function fetchMemberInfoDiscord(guildId, userId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildMember(guildId, userId));
}
async function fetchRoleInfoDiscord(guildId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildRoles(guildId));
}
async function addRoleDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.put(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
  return { ok: true };
}
async function removeRoleDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
  return { ok: true };
}
async function fetchChannelInfoDiscord(channelId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.channel(channelId));
}
async function listGuildChannelsDiscord(guildId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildChannels(guildId));
}
async function fetchVoiceStatusDiscord(guildId, userId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildVoiceState(guildId, userId));
}
async function listScheduledEventsDiscord(guildId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildScheduledEvents(guildId));
}
async function createScheduledEventDiscord(guildId, payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.post(Routes.guildScheduledEvents(guildId), {
    body: payload
  });
}
async function timeoutMemberDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  let until = payload.until;
  if (!until && payload.durationMinutes) {
    const ms = payload.durationMinutes * 60 * 1e3;
    until = new Date(Date.now() + ms).toISOString();
  }
  return await rest.patch(Routes.guildMember(payload.guildId, payload.userId), {
    body: { communication_disabled_until: until ?? null },
    headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
  });
}
async function kickMemberDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMember(payload.guildId, payload.userId), {
    headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
  });
  return { ok: true };
}
async function banMemberDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  const deleteMessageDays = typeof payload.deleteMessageDays === "number" && Number.isFinite(payload.deleteMessageDays) ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7) : void 0;
  await rest.put(Routes.guildBan(payload.guildId, payload.userId), {
    body: deleteMessageDays !== void 0 ? { delete_message_days: deleteMessageDays } : void 0,
    headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
  });
  return { ok: true };
}
export {
  addRoleDiscord,
  banMemberDiscord,
  createScheduledEventDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listScheduledEventsDiscord,
  removeRoleDiscord,
  timeoutMemberDiscord
};
