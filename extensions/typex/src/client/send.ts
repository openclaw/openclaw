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
  to: string,
  content: string | { text?: string },
  opts: TypeXSendOpts = {},
) {
  const msgType = opts.msgType || TypeXMessageEnum.text;
  let finalContent: string | object = content;

  if (opts.mediaUrl) {
    throw new Error("TypeX media sending is not supported yet.");
  }

  return await client.sendMessage(to, finalContent, msgType);
}
