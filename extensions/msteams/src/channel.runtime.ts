import {
  listMSTeamsDirectoryGroupsLive as listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive as listMSTeamsDirectoryPeersLiveImpl,
} from "./directory-live.js";
import {
  getMessageMSTeams as getMessageMSTeamsImpl,
  listPinsMSTeams as listPinsMSTeamsImpl,
  listReactionsMSTeams as listReactionsMSTeamsImpl,
  pinMessageMSTeams as pinMessageMSTeamsImpl,
  reactMessageMSTeams as reactMessageMSTeamsImpl,
  searchMessagesMSTeams as searchMessagesMSTeamsImpl,
  unpinMessageMSTeams as unpinMessageMSTeamsImpl,
  unreactMessageMSTeams as unreactMessageMSTeamsImpl,
} from "./graph-messages.js";
import { editChannelMSTeams as editChannelMSTeamsImpl } from "./graph.js";
import { msteamsOutbound as msteamsOutboundImpl } from "./outbound.js";
import { probeMSTeams as probeMSTeamsImpl } from "./probe.js";
import {
  deleteMessageMSTeams as deleteMessageMSTeamsImpl,
  editMessageMSTeams as editMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
  sendTypingMSTeams as sendTypingMSTeamsImpl,
} from "./send.js";
export const msTeamsChannelRuntime = {
  deleteMessageMSTeams: deleteMessageMSTeamsImpl,
  editChannelMSTeams: editChannelMSTeamsImpl,
  editMessageMSTeams: editMessageMSTeamsImpl,
  getMessageMSTeams: getMessageMSTeamsImpl,
  listPinsMSTeams: listPinsMSTeamsImpl,
  listReactionsMSTeams: listReactionsMSTeamsImpl,
  pinMessageMSTeams: pinMessageMSTeamsImpl,
  reactMessageMSTeams: reactMessageMSTeamsImpl,
  searchMessagesMSTeams: searchMessagesMSTeamsImpl,
  sendTypingMSTeams: sendTypingMSTeamsImpl,
  unpinMessageMSTeams: unpinMessageMSTeamsImpl,
  unreactMessageMSTeams: unreactMessageMSTeamsImpl,
  listMSTeamsDirectoryGroupsLive: listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive: listMSTeamsDirectoryPeersLiveImpl,
  msteamsOutbound: { ...msteamsOutboundImpl },
  probeMSTeams: probeMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams: sendMessageMSTeamsImpl,
};
