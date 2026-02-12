/**
 * DingTalk-specific channelData types for Clawdbot.
 * Used to send rich messages like ActionCards, images, and files.
 */

/**
 * ActionCard button definition.
 */
export interface DingTalkActionCardButton {
  /** Button label text */
  title: string;
  /** URL to open when button is clicked */
  actionURL: string;
}

/**
 * ActionCard message configuration.
 * Supports both single-button and multi-button layouts.
 */
export interface DingTalkActionCard {
  /** Card title */
  title: string;
  /** Card body text (supports Markdown) */
  text: string;
  /** Single button title (for single-button mode) */
  singleTitle?: string;
  /** Single button URL (for single-button mode) */
  singleURL?: string;
  /** Button orientation: "0" = vertical, "1" = horizontal */
  btnOrientation?: "0" | "1";
  /** Multiple buttons (for multi-button mode, 2-5 buttons) */
  buttons?: DingTalkActionCardButton[];
}

/**
 * Image message configuration.
 */
export interface DingTalkImage {
  /** Image URL */
  picUrl?: string;
}

/**
 * File message configuration.
 */
export interface DingTalkFile {
  /** Media ID from upload API */
  mediaId?: string;
  /** File name for display */
  fileName?: string;
  /** File type (pdf, doc, xls, etc.) */
  fileType?: string;
}

/**
 * DingTalk-specific channelData payload.
 * Pass this in payload.channelData.dingtalk when using sendPayload.
 */
export interface DingTalkChannelData {
  /** ActionCard configuration */
  actionCard?: DingTalkActionCard;
  /** Image configuration */
  image?: DingTalkImage;
  /** File configuration */
  file?: DingTalkFile;
}
