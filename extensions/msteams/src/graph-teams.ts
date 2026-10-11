import type { OpenClawConfig } from "../runtime-api.js";
import { fetchAllGraphPages, fetchGraphJson, resolveGraphToken } from "./graph.js";

type GraphTeamsChannel = {
  id?: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
  createdDateTime?: string;
};

type ListChannelsMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  teamId: string;
};

type GetChannelInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  teamId: string;
  channelId: string;
};

export async function listChannelsMSTeams(params: ListChannelsMSTeamsParams) {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const result = await fetchAllGraphPages<GraphTeamsChannel>({
    token,
    path: `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType`,
    maxPages: 10,
  });
  const channels = result.items.map((ch) => ({
    id: ch.id,
    displayName: ch.displayName,
    description: ch.description,
    membershipType: ch.membershipType,
  }));
  return { channels, truncated: result.truncated };
}

export async function getChannelInfoMSTeams(params: GetChannelInfoMSTeamsParams) {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
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
