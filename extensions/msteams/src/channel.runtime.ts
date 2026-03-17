import {
  listMSTeamsDirectoryGroupsLive as listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive as listMSTeamsDirectoryPeersLiveImpl,
} from "./directory-live.js";
import { msteamsOutbound as msteamsOutboundImpl } from "./outbound.js";
import { probeMSTeams as probeMSTeamsImpl } from "./probe.js";
import {
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
} from "./send.js";

type ListMSTeamsDirectoryGroupsLive =
  typeof import("./directory-live.js").listMSTeamsDirectoryGroupsLive;
type ListMSTeamsDirectoryPeersLive =
  typeof import("./directory-live.js").listMSTeamsDirectoryPeersLive;
type MSTeamsOutbound = typeof import("./outbound.js").msteamsOutbound;
type ProbeMSTeams = typeof import("./probe.js").probeMSTeams;
type SendAdaptiveCardMSTeams = typeof import("./send.js").sendAdaptiveCardMSTeams;
type SendMessageMSTeams = typeof import("./send.js").sendMessageMSTeams;

export function listMSTeamsDirectoryGroupsLive(
  ...args: Parameters<ListMSTeamsDirectoryGroupsLive>
): ReturnType<ListMSTeamsDirectoryGroupsLive> {
  return listMSTeamsDirectoryGroupsLiveImpl(...args);
}

export function listMSTeamsDirectoryPeersLive(
  ...args: Parameters<ListMSTeamsDirectoryPeersLive>
): ReturnType<ListMSTeamsDirectoryPeersLive> {
  return listMSTeamsDirectoryPeersLiveImpl(...args);
}

export const msteamsOutbound: MSTeamsOutbound = { ...msteamsOutboundImpl };

export function probeMSTeams(...args: Parameters<ProbeMSTeams>): ReturnType<ProbeMSTeams> {
  return probeMSTeamsImpl(...args);
}

export function sendAdaptiveCardMSTeams(
  ...args: Parameters<SendAdaptiveCardMSTeams>
): ReturnType<SendAdaptiveCardMSTeams> {
  return sendAdaptiveCardMSTeamsImpl(...args);
}

export function sendMessageMSTeams(
  ...args: Parameters<SendMessageMSTeams>
): ReturnType<SendMessageMSTeams> {
  return sendMessageMSTeamsImpl(...args);
}
