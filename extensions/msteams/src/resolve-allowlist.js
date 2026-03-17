import { mapAllowlistResolutionInputs } from "openclaw/plugin-sdk/compat";
import { searchGraphUsers } from "./graph-users.js";
import {
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken
} from "./graph.js";
function stripProviderPrefix(raw) {
  return raw.replace(/^(msteams|teams):/i, "");
}
function normalizeMSTeamsMessagingTarget(raw) {
  let trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  trimmed = stripProviderPrefix(trimmed).trim();
  if (/^conversation:/i.test(trimmed)) {
    const id = trimmed.slice("conversation:".length).trim();
    return id ? `conversation:${id}` : void 0;
  }
  if (/^user:/i.test(trimmed)) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : void 0;
  }
  return trimmed || void 0;
}
function normalizeMSTeamsUserInput(raw) {
  return stripProviderPrefix(raw).replace(/^(user|conversation):/i, "").trim();
}
function parseMSTeamsConversationId(raw) {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!/^conversation:/i.test(trimmed)) {
    return null;
  }
  const id = trimmed.slice("conversation:".length).trim();
  return id;
}
function normalizeMSTeamsTeamKey(raw) {
  const trimmed = stripProviderPrefix(raw).replace(/^team:/i, "").trim();
  return trimmed || void 0;
}
function normalizeMSTeamsChannelKey(raw) {
  const trimmed = raw?.trim().replace(/^#/, "").trim() ?? "";
  return trimmed || void 0;
}
function parseMSTeamsTeamChannelInput(raw) {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) {
    return {};
  }
  const parts = trimmed.split("/");
  const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
  const channel = parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : void 0;
  return {
    ...team ? { team } : {},
    ...channel ? { channel } : {}
  };
}
function parseMSTeamsTeamEntry(raw) {
  const { team, channel } = parseMSTeamsTeamChannelInput(raw);
  if (!team) {
    return null;
  }
  return {
    teamKey: team,
    ...channel ? { channelKey: channel } : {}
  };
}
async function resolveMSTeamsChannelAllowlist(params) {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input) => {
      const { team, channel } = parseMSTeamsTeamChannelInput(input);
      if (!team) {
        return { input, resolved: false };
      }
      const teams = /^[0-9a-fA-F-]{16,}$/.test(team) ? [{ id: team, displayName: team }] : await listTeamsByName(token, team);
      if (teams.length === 0) {
        return { input, resolved: false, note: "team not found" };
      }
      const teamMatch = teams[0];
      const graphTeamId = teamMatch.id?.trim();
      const teamName = teamMatch.displayName?.trim() || team;
      if (!graphTeamId) {
        return { input, resolved: false, note: "team id missing" };
      }
      let teamChannels = [];
      try {
        teamChannels = await listChannelsForTeam(token, graphTeamId);
      } catch {
      }
      const generalChannel = teamChannels.find((ch) => ch.displayName?.toLowerCase() === "general");
      const teamId = generalChannel?.id?.trim() || graphTeamId;
      if (!channel) {
        return {
          input,
          resolved: true,
          teamId,
          teamName,
          note: teams.length > 1 ? "multiple teams; chose first" : void 0
        };
      }
      const channelMatch = teamChannels.find((item) => item.id === channel) ?? teamChannels.find((item) => item.displayName?.toLowerCase() === channel.toLowerCase()) ?? teamChannels.find(
        (item) => item.displayName?.toLowerCase().includes(channel.toLowerCase() ?? "")
      );
      if (!channelMatch?.id) {
        return { input, resolved: false, note: "channel not found" };
      }
      return {
        input,
        resolved: true,
        teamId,
        teamName,
        channelId: channelMatch.id,
        channelName: channelMatch.displayName ?? channel,
        note: teamChannels.length > 1 ? "multiple channels; chose first" : void 0
      };
    }
  });
}
async function resolveMSTeamsUserAllowlist(params) {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input) => {
      const query = normalizeQuery(normalizeMSTeamsUserInput(input));
      if (!query) {
        return { input, resolved: false };
      }
      if (/^[0-9a-fA-F-]{16,}$/.test(query)) {
        return { input, resolved: true, id: query };
      }
      const users = await searchGraphUsers({ token, query, top: 10 });
      const match = users[0];
      if (!match?.id) {
        return { input, resolved: false };
      }
      return {
        input,
        resolved: true,
        id: match.id,
        name: match.displayName ?? void 0,
        note: users.length > 1 ? "multiple matches; chose first" : void 0
      };
    }
  });
}
export {
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist
};
