import {
  listMSTeamsDirectoryGroupsLive as listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive as listMSTeamsDirectoryPeersLiveImpl,
} from "./directory-live.js";
import {
  getMessageMSTeams as getMessageMSTeamsImpl,
  listPinsMSTeams as listPinsMSTeamsImpl,
  pinMessageMSTeams as pinMessageMSTeamsImpl,
  unpinMessageMSTeams as unpinMessageMSTeamsImpl,
} from "./graph-messages.js";
import { msteamsOutbound as msteamsOutboundImpl } from "./outbound.js";
import { probeMSTeams as probeMSTeamsImpl } from "./probe.js";
import {
  deleteMessageMSTeams as deleteMessageMSTeamsImpl,
  editMessageMSTeams as editMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
} from "./send.js";
export const msTeamsChannelRuntime = {
  deleteMessageMSTeams: deleteMessageMSTeamsImpl,
  editMessageMSTeams: editMessageMSTeamsImpl,
  getMessageMSTeams: getMessageMSTeamsImpl,
  listPinsMSTeams: listPinsMSTeamsImpl,
  pinMessageMSTeams: pinMessageMSTeamsImpl,
  unpinMessageMSTeams: unpinMessageMSTeamsImpl,
  listMSTeamsDirectoryGroupsLive: listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive: listMSTeamsDirectoryPeersLiveImpl,
  msteamsOutbound: { ...msteamsOutboundImpl },
  probeMSTeams: probeMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams: sendMessageMSTeamsImpl,
};
