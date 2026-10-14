import {
  assertFeishuChatMember,
  buildFeishuDirectChatMembers,
  getChatInfo,
  getChatMembers,
  getFeishuMemberInfo,
} from "./chat.js";
import { listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive } from "./directory.js";
import { sendStickerFeishu } from "./media.js";
import { feishuOutbound } from "./outbound.js";
import { createPinFeishu, listPinsFeishu, removePinFeishu } from "./pins.js";
import { probeFeishu } from "./probe.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu } from "./reactions.js";
import { editMessageFeishu, getMessageFeishu, sendCardFeishu, sendMessageFeishu } from "./send.js";

export const feishuChannelRuntime = {
  assertFeishuChatMember,
  buildFeishuDirectChatMembers,
  listFeishuDirectoryGroupsLive,
  listFeishuDirectoryPeersLive,
  feishuOutbound: { ...feishuOutbound },
  createPinFeishu,
  listPinsFeishu,
  removePinFeishu,
  probeFeishu,
  addReactionFeishu,
  listReactionsFeishu,
  removeReactionFeishu,
  getChatInfo,
  getChatMembers,
  getFeishuMemberInfo,
  editMessageFeishu,
  getMessageFeishu,
  sendCardFeishu,
  sendMessageFeishu,
  sendStickerFeishu,
};
