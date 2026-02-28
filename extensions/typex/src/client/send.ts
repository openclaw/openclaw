import { formatErrorMessage } from "openclaw/plugin-sdk";
import type { TypeXClient } from "./client.js";
// import { loadWebMedia } from "../web/media.js";
import { TypeXMessageEnum } from "./types.js";

export type TypeXSendOpts = {
  msgType?: TypeXMessageEnum;
  mediaUrl?: string;
  maxBytes?: number;
};

export async function sendMessageTypeX(
  client: TypeXClient,
  content: string | { text?: string },
  opts: TypeXSendOpts = {},
) {
  let msgType = opts.msgType || TypeXMessageEnum.text;
  let finalContent: string | object = content;

  // Send the main message
  try {
    const res = await client.sendMessage(finalContent, msgType);
    return res;
  } catch (err) {
    throw err;
  }
}
