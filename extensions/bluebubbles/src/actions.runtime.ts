import { sendBlueBubblesAttachment as sendBlueBubblesAttachmentImpl } from "./attachments.js";
import {
  addBlueBubblesParticipant as addBlueBubblesParticipantImpl,
  editBlueBubblesMessage as editBlueBubblesMessageImpl,
  leaveBlueBubblesChat as leaveBlueBubblesChatImpl,
  removeBlueBubblesParticipant as removeBlueBubblesParticipantImpl,
  renameBlueBubblesChat as renameBlueBubblesChatImpl,
  setGroupIconBlueBubbles as setGroupIconBlueBubblesImpl,
  unsendBlueBubblesMessage as unsendBlueBubblesMessageImpl,
} from "./chat.js";
import { resolveBlueBubblesMessageId as resolveBlueBubblesMessageIdImpl } from "./monitor.js";
import { sendBlueBubblesReaction as sendBlueBubblesReactionImpl } from "./reactions.js";
import {
  resolveChatGuidForTarget as resolveChatGuidForTargetImpl,
  sendMessageBlueBubbles as sendMessageBlueBubblesImpl,
} from "./send.js";

type SendBlueBubblesAttachment = typeof import("./attachments.js").sendBlueBubblesAttachment;
type AddBlueBubblesParticipant = typeof import("./chat.js").addBlueBubblesParticipant;
type EditBlueBubblesMessage = typeof import("./chat.js").editBlueBubblesMessage;
type LeaveBlueBubblesChat = typeof import("./chat.js").leaveBlueBubblesChat;
type RemoveBlueBubblesParticipant = typeof import("./chat.js").removeBlueBubblesParticipant;
type RenameBlueBubblesChat = typeof import("./chat.js").renameBlueBubblesChat;
type SetGroupIconBlueBubbles = typeof import("./chat.js").setGroupIconBlueBubbles;
type UnsendBlueBubblesMessage = typeof import("./chat.js").unsendBlueBubblesMessage;
type ResolveBlueBubblesMessageId = typeof import("./monitor.js").resolveBlueBubblesMessageId;
type SendBlueBubblesReaction = typeof import("./reactions.js").sendBlueBubblesReaction;
type ResolveChatGuidForTarget = typeof import("./send.js").resolveChatGuidForTarget;
type SendMessageBlueBubbles = typeof import("./send.js").sendMessageBlueBubbles;

export function sendBlueBubblesAttachment(
  ...args: Parameters<SendBlueBubblesAttachment>
): ReturnType<SendBlueBubblesAttachment> {
  return sendBlueBubblesAttachmentImpl(...args);
}

export function addBlueBubblesParticipant(
  ...args: Parameters<AddBlueBubblesParticipant>
): ReturnType<AddBlueBubblesParticipant> {
  return addBlueBubblesParticipantImpl(...args);
}

export function editBlueBubblesMessage(
  ...args: Parameters<EditBlueBubblesMessage>
): ReturnType<EditBlueBubblesMessage> {
  return editBlueBubblesMessageImpl(...args);
}

export function leaveBlueBubblesChat(
  ...args: Parameters<LeaveBlueBubblesChat>
): ReturnType<LeaveBlueBubblesChat> {
  return leaveBlueBubblesChatImpl(...args);
}

export function removeBlueBubblesParticipant(
  ...args: Parameters<RemoveBlueBubblesParticipant>
): ReturnType<RemoveBlueBubblesParticipant> {
  return removeBlueBubblesParticipantImpl(...args);
}

export function renameBlueBubblesChat(
  ...args: Parameters<RenameBlueBubblesChat>
): ReturnType<RenameBlueBubblesChat> {
  return renameBlueBubblesChatImpl(...args);
}

export function setGroupIconBlueBubbles(
  ...args: Parameters<SetGroupIconBlueBubbles>
): ReturnType<SetGroupIconBlueBubbles> {
  return setGroupIconBlueBubblesImpl(...args);
}

export function unsendBlueBubblesMessage(
  ...args: Parameters<UnsendBlueBubblesMessage>
): ReturnType<UnsendBlueBubblesMessage> {
  return unsendBlueBubblesMessageImpl(...args);
}

export function resolveBlueBubblesMessageId(
  ...args: Parameters<ResolveBlueBubblesMessageId>
): ReturnType<ResolveBlueBubblesMessageId> {
  return resolveBlueBubblesMessageIdImpl(...args);
}

export function sendBlueBubblesReaction(
  ...args: Parameters<SendBlueBubblesReaction>
): ReturnType<SendBlueBubblesReaction> {
  return sendBlueBubblesReactionImpl(...args);
}

export function resolveChatGuidForTarget(
  ...args: Parameters<ResolveChatGuidForTarget>
): ReturnType<ResolveChatGuidForTarget> {
  return resolveChatGuidForTargetImpl(...args);
}

export function sendMessageBlueBubbles(
  ...args: Parameters<SendMessageBlueBubbles>
): ReturnType<SendMessageBlueBubbles> {
  return sendMessageBlueBubblesImpl(...args);
}
