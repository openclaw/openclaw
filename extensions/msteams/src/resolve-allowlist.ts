import { mapAllowlistResolutionInputs } from "openclaw/plugin-sdk/compat";
import { searchGraphUsers } from "./graph-users.js";
import {
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken,
} from "./graph.js";

export type MSTeamsChannelResolution = {
  input: string;
  resolved: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  note?: string;
};

export type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(msteams|teams):/i, "");
}

export function normalizeMSTeamsMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  trimmed = stripProviderPrefix(trimmed).trim();
  if (/^conversation:/i.test(trimmed)) {
    const id = trimmed.slice("conversation:".length).trim();
    return id ? `conversation:${id}` : undefined;
  }
  if (/^user:/i.test(trimmed)) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  return trimmed || undefined;
}

export function normalizeMSTeamsUserInput(raw: string): string {
  return stripProviderPrefix(raw)
    .replace(/^(user|conversation):/i, "")
    .trim();
}

export function parseMSTeamsConversationId(raw: string): string | null {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!/^conversation:/i.test(trimmed)) {
    return null;
  }
  const id = trimmed.slice("conversation:".length).trim();
  return id;
}

function normalizeMSTeamsTeamKey(raw: string): string | undefined {
  const trimmed = stripProviderPrefix(raw)
    .replace(/^team:/i, "")
    .trim();
  return trimmed || undefined;
}

function normalizeMSTeamsChannelKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^#/, "").trim() ?? "";
  return trimmed || undefined;
}

export function parseMSTeamsTeamChannelInput(raw: string): { team?: string; channel?: string } {
  const trimmed = stripProviderPrefix(raw).trim();
  if (!trimmed) {
    return {};
  }
  const parts = trimmed.split("/");
  const team = normalizeMSTeamsTeamKey(parts[0] ?? "");
  const channel =
    parts.length > 1 ? normalizeMSTeamsChannelKey(parts.slice(1).join("/")) : undefined;
  return {
    ...(team ? { team } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function parseMSTeamsTeamEntry(
  raw: string,
): { teamKey: string; channelKey?: string } | null {
  const { team, channel } = parseMSTeamsTeamChannelInput(raw);
  if (!team) {
    return null;
  }
  return {
    teamKey: team,
    ...(channel ? { channelKey: channel } : {}),
  };
}

export async function resolveMSTeamsChannelAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsChannelResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsChannelResolution> => {
      const { team, channel } = parseMSTeamsTeamChannelInput(input);
      if (!team) {
        return { input, resolved: false };
      }
      const teams = /^[0-9a-fA-F-]{16,}$/.test(team)
        ? [{ id: team, displayName: team }]
        : await listTeamsByName(token, team);
      if (teams.length === 0) {
        return { input, resolved: false, note: "team not found" };
      }
      const teamMatch = teams[0];
      const graphTeamId = teamMatch.id?.trim();
      const teamName = teamMatch.displayName?.trim() || team;
      if (!graphTeamId) {
        return { input, resolved: false, note: "team id missing" };
      }
      // Bot Framework sends the General channel's conversation ID as
      // channelData.team.id at runtime, NOT the Graph API group GUID.
      // Fetch channels upfront so we can resolve the correct key format for
      // runtime matching and reuse the list for channel lookups.
      let teamChannels: Awaited<ReturnType<typeof listChannelsForTeam>> = [];
      try {
        teamChannels = await listChannelsForTeam(token, graphTeamId);
      } catch {
        // API failure (rate limit, network error) — fall back to Graph GUID as team key
      }
      const generalChannel = teamChannels.find((ch) => ch.displayName?.toLowerCase() === "general");
      // Use the General channel's conversation ID as the team key — this
      // matches what Bot Framework sends at runtime. Fall back to the Graph
      // GUID if the General channel isn't found (renamed or deleted).
      const teamId = generalChannel?.id?.trim() || graphTeamId;
      if (!channel) {
        return {
          input,
          resolved: true,
          teamId,
          teamName,
          note: teams.length > 1 ? "multiple teams; chose first" : undefined,
        };
      }
      // Reuse teamChannels — already fetched above
      const channelMatch =
        teamChannels.find((item) => item.id === channel) ??
        teamChannels.find((item) => item.displayName?.toLowerCase() === channel.toLowerCase()) ??
        teamChannels.find((item) =>
          item.displayName?.toLowerCase().includes(channel.toLowerCase() ?? ""),
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
        note: teamChannels.length > 1 ? "multiple channels; chose first" : undefined,
      };
    },
  });
}

export async function resolveMSTeamsUserAllowlist(params: {
  cfg: unknown;
  entries: string[];
}): Promise<MSTeamsUserResolution[]> {
  const token = await resolveGraphToken(params.cfg);
  return await mapAllowlistResolutionInputs({
    inputs: params.entries,
    mapInput: async (input): Promise<MSTeamsUserResolution> => {
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
        name: match.displayName ?? undefined,
        note: users.length > 1 ? "multiple matches; chose first" : undefined,
      };
    },
  });
}
