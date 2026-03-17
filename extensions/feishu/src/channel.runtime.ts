import {
  getChatInfo as getChatInfoImpl,
  getChatMembers as getChatMembersImpl,
  getFeishuMemberInfo as getFeishuMemberInfoImpl,
} from "./chat.js";
import {
  listFeishuDirectoryGroupsLive as listFeishuDirectoryGroupsLiveImpl,
  listFeishuDirectoryPeersLive as listFeishuDirectoryPeersLiveImpl,
} from "./directory.js";
import { feishuOutbound as feishuOutboundImpl } from "./outbound.js";
import {
  createPinFeishu as createPinFeishuImpl,
  listPinsFeishu as listPinsFeishuImpl,
  removePinFeishu as removePinFeishuImpl,
} from "./pins.js";
import { probeFeishu as probeFeishuImpl } from "./probe.js";
import {
  addReactionFeishu as addReactionFeishuImpl,
  listReactionsFeishu as listReactionsFeishuImpl,
  removeReactionFeishu as removeReactionFeishuImpl,
} from "./reactions.js";
import {
  editMessageFeishu as editMessageFeishuImpl,
  getMessageFeishu as getMessageFeishuImpl,
  sendCardFeishu as sendCardFeishuImpl,
  sendMessageFeishu as sendMessageFeishuImpl,
} from "./send.js";

type ListFeishuDirectoryGroupsLive = typeof import("./directory.js").listFeishuDirectoryGroupsLive;
type ListFeishuDirectoryPeersLive = typeof import("./directory.js").listFeishuDirectoryPeersLive;
type FeishuOutbound = typeof import("./outbound.js").feishuOutbound;
type CreatePinFeishu = typeof import("./pins.js").createPinFeishu;
type ListPinsFeishu = typeof import("./pins.js").listPinsFeishu;
type RemovePinFeishu = typeof import("./pins.js").removePinFeishu;
type ProbeFeishu = typeof import("./probe.js").probeFeishu;
type AddReactionFeishu = typeof import("./reactions.js").addReactionFeishu;
type ListReactionsFeishu = typeof import("./reactions.js").listReactionsFeishu;
type RemoveReactionFeishu = typeof import("./reactions.js").removeReactionFeishu;
type GetChatInfo = typeof import("./chat.js").getChatInfo;
type GetChatMembers = typeof import("./chat.js").getChatMembers;
type GetFeishuMemberInfo = typeof import("./chat.js").getFeishuMemberInfo;
type EditMessageFeishu = typeof import("./send.js").editMessageFeishu;
type GetMessageFeishu = typeof import("./send.js").getMessageFeishu;
type SendCardFeishu = typeof import("./send.js").sendCardFeishu;
type SendMessageFeishu = typeof import("./send.js").sendMessageFeishu;

export function listFeishuDirectoryGroupsLive(
  ...args: Parameters<ListFeishuDirectoryGroupsLive>
): ReturnType<ListFeishuDirectoryGroupsLive> {
  return listFeishuDirectoryGroupsLiveImpl(...args);
}

export function listFeishuDirectoryPeersLive(
  ...args: Parameters<ListFeishuDirectoryPeersLive>
): ReturnType<ListFeishuDirectoryPeersLive> {
  return listFeishuDirectoryPeersLiveImpl(...args);
}

export const feishuOutbound: FeishuOutbound = { ...feishuOutboundImpl };

export function createPinFeishu(...args: Parameters<CreatePinFeishu>): ReturnType<CreatePinFeishu> {
  return createPinFeishuImpl(...args);
}

export function listPinsFeishu(...args: Parameters<ListPinsFeishu>): ReturnType<ListPinsFeishu> {
  return listPinsFeishuImpl(...args);
}

export function removePinFeishu(...args: Parameters<RemovePinFeishu>): ReturnType<RemovePinFeishu> {
  return removePinFeishuImpl(...args);
}

export function probeFeishu(...args: Parameters<ProbeFeishu>): ReturnType<ProbeFeishu> {
  return probeFeishuImpl(...args);
}

export function addReactionFeishu(
  ...args: Parameters<AddReactionFeishu>
): ReturnType<AddReactionFeishu> {
  return addReactionFeishuImpl(...args);
}

export function listReactionsFeishu(
  ...args: Parameters<ListReactionsFeishu>
): ReturnType<ListReactionsFeishu> {
  return listReactionsFeishuImpl(...args);
}

export function removeReactionFeishu(
  ...args: Parameters<RemoveReactionFeishu>
): ReturnType<RemoveReactionFeishu> {
  return removeReactionFeishuImpl(...args);
}

export function getChatInfo(...args: Parameters<GetChatInfo>): ReturnType<GetChatInfo> {
  return getChatInfoImpl(...args);
}

export function getChatMembers(...args: Parameters<GetChatMembers>): ReturnType<GetChatMembers> {
  return getChatMembersImpl(...args);
}

export function getFeishuMemberInfo(
  ...args: Parameters<GetFeishuMemberInfo>
): ReturnType<GetFeishuMemberInfo> {
  return getFeishuMemberInfoImpl(...args);
}

export function editMessageFeishu(
  ...args: Parameters<EditMessageFeishu>
): ReturnType<EditMessageFeishu> {
  return editMessageFeishuImpl(...args);
}

export function getMessageFeishu(
  ...args: Parameters<GetMessageFeishu>
): ReturnType<GetMessageFeishu> {
  return getMessageFeishuImpl(...args);
}

export function sendCardFeishu(...args: Parameters<SendCardFeishu>): ReturnType<SendCardFeishu> {
  return sendCardFeishuImpl(...args);
}

export function sendMessageFeishu(
  ...args: Parameters<SendMessageFeishu>
): ReturnType<SendMessageFeishu> {
  return sendMessageFeishuImpl(...args);
}
