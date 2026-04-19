/**
 * Message type handler common type definitions.
 *
 * Each Tencent IM message type (TIMTextElem, TIMImageElem, etc.) implements the MessageElemHandler interface,
 * providing both input parsing (extract) and output construction (buildMsgBody).
 */

import type { MessageHandlerContext } from "../context.js";

/** Single MsgBody element (Tencent IM raw format) */
export type MsgBodyItemType = {
  msg_type: string;
  msg_content: {
    text?: string; // text chat content
    uuid?: string; // image
    image_format?: number; // image format
    data?: string; // extension data
    desc?: string; // description
    ext?: string; // extension field
    sound?: string; // voice
    image_info_array?: Array<{
      type?: number;
      size?: number;
      width?: number;
      height?: number;
      url?: string;
    }>; // image content
    index?: number; // emoji index
    url?: string; // file download URL
    file_size?: number; // file size (bytes)
    file_name?: string; // file name
    [key: string]: unknown;
  };
};

/** Media resource item */
export type MediaItem = {
  mediaType: "image" | "file";
  url: string;
  mediaName?: string;
};

/** Mentioned user */
export type MentionItem = {
  userId: string;
  text: string;
};

/** Structured result extracted from MsgBody */
export type ExtractTextFromMsgBodyResult = {
  rawBody: string;
  isAtBot: boolean;
  /** Media resource list (images, files, etc.) */
  medias: MediaItem[];
  mentions: MentionItem[];
  /** Bot display name extracted from @mention text (without @ prefix) */
  botUsername?: string;
  /** URL list extracted from link cards (for LinkUnderstanding) */
  linkUrls: string[];
};

/**
 * Outbound content item: a content fragment extracted from reply content.
 *
 * Outbound message MsgBody construction has two steps:
 * 1. Content formatting (prepareOutboundContent) → extract OutboundContentItem[]
 * 2. Each type handler's buildMsgBody converts items → compose final MsgBody
 */
export type OutboundContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      url: string;
      uuid?: string;
      imageFormat?: number;
      imageInfoArray?: Array<{
        type?: number;
        size?: number;
        width?: number;
        height?: number;
        url?: string;
      }>;
    }
  | { type: "file"; url: string; fileName?: string; fileSize?: number; uuid?: string }
  | { type: "video"; videoUrl: string; [key: string]: unknown }
  | { type: "custom"; data: string | Record<string, unknown> };

/**
 * Message element handler interface.
 *
 * Each message type implements:
 * - msgType: corresponding Tencent IM message type identifier (e.g. "TIMTextElem")
 * - extract: input parsing — extract text representation from raw MsgBody element
 * - buildMsgBody: output construction — build sendable MsgBody elements from business data (optional)
 */
export interface MessageElemHandler {
  /** Message type identifier */
  readonly msgType: string;

  /**
   * Input parsing: extract text representation from message element.
   */
  extract(
    ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined;

  /**
   * Output construction: build sendable MsgBody elements from business data (optional).
   *
   * Not all message types support sending (e.g. TIMSoundElem is typically receive-only).
   * Not implementing this method means this type does not support active construction.
   */
  buildMsgBody?(data: Record<string, unknown>): MsgBodyItemType[];
}
