import type { OpenClawConfig } from "../runtime-api.js";
import { type GraphResponse, fetchGraphJson, resolveGraphToken } from "./graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphTeamsChannel = {
  id?: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
  createdDateTime?: string;
};

export type ListChannelsMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
};

export type ListChannelsMSTeamsResult = {
  channels: Array<{
    id: string | undefined;
    displayName: string | undefined;
    description: string | undefined;
    membershipType: string | undefined;
  }>;
};

export type GetChannelInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
  channelId: string;
};

export type GetChannelInfoMSTeamsResult = {
  channel: {
    id: string | undefined;
    displayName: string | undefined;
    description: string | undefined;
    membershipType: string | undefined;
    webUrl: string | undefined;
    createdDateTime: string | undefined;
  };
};

// ---------------------------------------------------------------------------
// List channels for a team
// ---------------------------------------------------------------------------

/**
 * List channels in a team via Graph API.
 * Returns id, displayName, description, and membershipType for each channel.
 */
export async function listChannelsMSTeams(
  params: ListChannelsMSTeamsParams,
): Promise<ListChannelsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType`;
  const res = await fetchGraphJson<GraphResponse<GraphTeamsChannel>>({ token, path });
  const channels = (res.value ?? []).map((ch) => ({
    id: ch.id,
    displayName: ch.displayName,
    description: ch.description,
    membershipType: ch.membershipType,
  }));
  return { channels };
}

// ---------------------------------------------------------------------------
// Get channel info
// ---------------------------------------------------------------------------

/**
 * Get detailed information about a single channel in a team via Graph API.
 * Returns id, displayName, description, membershipType, webUrl, and createdDateTime.
 */
export async function getChannelInfoMSTeams(
  params: GetChannelInfoMSTeamsParams,
): Promise<GetChannelInfoMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}?$select=id,displayName,description,membershipType,webUrl,createdDateTime`;
  const ch = await fetchGraphJson<GraphTeamsChannel>({ token, path });
  return {
    channel: {
      id: ch.id,
      displayName: ch.displayName,
      description: ch.description,
      membershipType: ch.membershipType,
      webUrl: ch.webUrl,
      createdDateTime: ch.createdDateTime,
    },
  };
}
