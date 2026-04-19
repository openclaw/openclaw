/** Message type handler registry. */

import type { Member } from "../../../infra/cache/member.js";
import { mdTable, mdMath } from "../../utils/markdown.js";
import { customHandler } from "./custom.js";
import { faceHandler } from "./face.js";
import { fileHandler } from "./file.js";
import { imageHandler } from "./image.js";
import { soundHandler } from "./sound.js";
import { textHandler } from "./text.js";
import type { MessageElemHandler, MsgBodyItemType, OutboundContentItem } from "./types.js";
import { videoHandler } from "./video.js";

const handlerList: MessageElemHandler[] = [
  textHandler,
  customHandler,
  imageHandler,
  soundHandler,
  fileHandler,
  videoHandler,
  faceHandler,
];

const handlerMap = new Map<string, MessageElemHandler>(handlerList.map((h) => [h.msgType, h]));

const outboundTypeToMsgType: Record<string, string> = {
  text: "TIMTextElem",
  image: "TIMImageElem",
  file: "TIMFileElem",
  video: "TIMVideoFileElem",
  custom: "TIMCustomElem",
};

export function getHandler(msgType: string): MessageElemHandler | undefined {
  return handlerMap.get(msgType);
}

export function getAllHandlers(): readonly MessageElemHandler[] {
  return handlerList;
}

export function buildMsgBody(
  msgType: string,
  data: Record<string, unknown>,
): MsgBodyItemType[] | undefined {
  const handler = handlerMap.get(msgType);
  return handler?.buildMsgBody?.(data);
}

const AT_USER_RE = /(?<=\s|^)@(\S+?)(?=\s|$)/g;

function resolveAtMentions(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  const items: OutboundContentItem[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(AT_USER_RE)) {
    const matchStart = match.index;

    // Text fragment before @user
    if (matchStart > lastIndex) {
      const before = text.slice(lastIndex, matchStart);
      if (before.trim()) {
        items.push({ type: "text", text: before.trim() });
      }
    }

    const nickName = match[1];
    const userRecord =
      groupCode && memberInst ? memberInst.lookupUserByNickName(groupCode, nickName) : undefined;

    if (userRecord) {
      // User found, insert custom type @mention message
      items.push({
        type: "custom",
        data: JSON.stringify({
          elem_type: 1002,
          text: `@${userRecord.nickName}`,
          user_id: userRecord.userId,
        }),
      });
    } else {
      // Not found, preserve original text as text type
      items.push({ type: "text", text: `@${nickName}` });
    }

    lastIndex = matchStart + match[0].length;
  }

  // Remaining trailing text
  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex);
    if (trailing.trim()) {
      items.push({ type: "text", text: trailing.trim() });
    }
  }

  // No matches: return original text
  if (items.length === 0 && text.trim()) {
    items.push({ type: "text", text: text.trim() });
  }

  return items;
}

export function prepareOutboundContent(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  if (!text) {
    return [];
  }

  const sanitizedText = mdTable.sanitize(mdMath.normalize(text));

  const items: OutboundContentItem[] = [];

  // Process text with @user resolution
  if (sanitizedText.length) {
    const trailing = sanitizedText.trim();
    if (trailing) {
      items.push(...resolveAtMentions(trailing, groupCode, memberInst));
    }
  }

  // If no matches, parse entire text for @user mentions
  if (items.length === 0 && sanitizedText.trim()) {
    items.push(...resolveAtMentions(sanitizedText.trim(), groupCode, memberInst));
  }

  return items;
}

export function buildOutboundMsgBody(items: OutboundContentItem[]): MsgBodyItemType[] {
  const msgBody: MsgBodyItemType[] = [];

  for (const item of items) {
    const msgType = outboundTypeToMsgType[item.type];
    if (!msgType) {
      continue;
    }

    const handler = handlerMap.get(msgType);
    if (!handler?.buildMsgBody) {
      continue;
    }

    // Convert OutboundContentItem to handler's data parameter
    const { type: _type, ...data } = item;
    const elems = handler.buildMsgBody(data as Record<string, unknown>);
    if (elems) {
      msgBody.push(...elems);
    }
  }

  return msgBody;
}

export type {
  MessageElemHandler,
  MsgBodyItemType,
  MediaItem,
  ExtractTextFromMsgBodyResult,
  OutboundContentItem,
} from "./types.js";

export { textHandler } from "./text.js";
export { customHandler, buildAtUserMsgBodyItem } from "./custom.js";
export { imageHandler } from "./image.js";
export { soundHandler } from "./sound.js";
export { fileHandler } from "./file.js";
export { videoHandler } from "./video.js";
export { faceHandler } from "./face.js";
