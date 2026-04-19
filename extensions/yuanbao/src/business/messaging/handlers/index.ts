/**
 * Message type handler registry.
 *
 * Unified registration and management of all message type handlers, providing:
 * - Handler lookup by msgType (for input parsing)
 * - Message body construction by msgType (for output sending)
 * - Outbound content preparation and msgBody construction pipeline
 *
 * To add a new message type:
 * 1. Create a handler file under handlers/ directory
 * 2. Register it in the handlerList below
 */

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

// ============ Handler registration ============

/** All registered message type handlers */
const handlerList: MessageElemHandler[] = [
  textHandler,
  customHandler,
  imageHandler,
  soundHandler,
  fileHandler,
  videoHandler,
  faceHandler,
];

/** msgType → Handler fast lookup map */
const handlerMap = new Map<string, MessageElemHandler>(handlerList.map((h) => [h.msgType, h]));

/**
 * OutboundContentItem.type → Tencent IM msgType mapping.
 *
 * Maps short content type identifiers ("text", "image", etc.) to corresponding handler msgType,
 * allowing buildOutboundMsgBody to find the correct handler for msgBody construction.
 */
const outboundTypeToMsgType: Record<string, string> = {
  text: "TIMTextElem",
  image: "TIMImageElem",
  file: "TIMFileElem",
  video: "TIMVideoFileElem",
  custom: "TIMCustomElem",
};

// ============ Public API ============

/**
 * Get handler by message type.
 */
export function getHandler(msgType: string): MessageElemHandler | undefined {
  return handlerMap.get(msgType);
}

/**
 * Get all registered handlers.
 */
export function getAllHandlers(): readonly MessageElemHandler[] {
  return handlerList;
}

/**
 * Build message body by msgType (convenience method).
 */
export function buildMsgBody(
  msgType: string,
  data: Record<string, unknown>,
): MsgBodyItemType[] | undefined {
  const handler = handlerMap.get(msgType);
  return handler?.buildMsgBody?.(data);
}

// ============ Outbound content preparation and MsgBody construction pipeline ============

/**
 * @user regex: whitespace (or line start) + @ + nickname + whitespace (or line end).
 *
 * Uses lookbehind to ensure preceding whitespace/line-start, lookahead for trailing whitespace/line-end.
 * Group 1: nickname (non-whitespace chars after @ until next whitespace)
 */
const AT_USER_RE = /(?<=\s|^)@(\S+?)(?=\s|$)/g;

/**
 * Parse @user mentions in a plain text fragment, splitting into text + custom mixed content items.
 *
 * Scans for whitespace+@+nickname+whitespace patterns:
 * - With groupCode and memberInst: queries member module, inserts custom type (elem_type: 1002) on hit
 * - No match or no groupCode/memberInst: preserves @nickname as text type
 */
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

/**
 * Content formatting preparation: extract raw text into structured content item list.
 *
 * Processing:
 * 1. Sanitize markdown (table/math normalization)
 * 2. Parse @user mentions, replacing matched @nickname with custom or preserving as text
 */
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

/**
 * Convert content item list to final MsgBody array via type-specific handlers.
 *
 * Iterates OutboundContentItem list, finds corresponding handler's buildMsgBody by type,
 * and merges all results into a complete MsgBody array.
 */
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

// ============ Export types and handlers ============

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
