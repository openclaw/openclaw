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
export const msTeamsChannelRuntime = {
  listMSTeamsDirectoryGroupsLive: listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive: listMSTeamsDirectoryPeersLiveImpl,
  msteamsOutbound: { ...msteamsOutboundImpl },
  probeMSTeams: probeMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams: sendMessageMSTeamsImpl,
};
