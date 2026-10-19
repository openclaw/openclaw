import { listMSTeamsDirectoryGroupsLive, listMSTeamsDirectoryPeersLive } from "./directory-live.js";
import {
  addParticipantMSTeams,
  removeParticipantMSTeams,
  renameGroupMSTeams,
} from "./graph-group-management.js";
import { getMemberInfoMSTeams } from "./graph-members.js";
import {
  getMessageMSTeams,
  listPinsMSTeams,
  listReactionsMSTeams,
  pinMessageMSTeams,
  reactMessageMSTeams,
  searchMessagesMSTeams,
  unpinMessageMSTeams,
  unreactMessageMSTeams,
} from "./graph-messages.js";
import { listChannelsMSTeams, getChannelInfoMSTeams } from "./graph-teams.js";
import { msteamsOutbound } from "./outbound.js";
import { probeMSTeams } from "./probe.js";
import {
  deleteMessageMSTeams,
  editMessageMSTeams,
  sendAdaptiveCardMSTeams,
  sendMessageMSTeams,
} from "./send.js";
export const msTeamsChannelRuntime = {
  addParticipantMSTeams,
  deleteMessageMSTeams,
  editMessageMSTeams,
  getChannelInfoMSTeams,
  getMemberInfoMSTeams,
  getMessageMSTeams,
  listChannelsMSTeams,
  listPinsMSTeams,
  listReactionsMSTeams,
  pinMessageMSTeams,
  reactMessageMSTeams,
  removeParticipantMSTeams,
  renameGroupMSTeams,
  searchMessagesMSTeams,
  unpinMessageMSTeams,
  unreactMessageMSTeams,
  listMSTeamsDirectoryGroupsLive,
  listMSTeamsDirectoryPeersLive,
  msteamsOutbound: { ...msteamsOutbound },
  probeMSTeams,
  sendAdaptiveCardMSTeams,
  sendMessageMSTeams,
};
