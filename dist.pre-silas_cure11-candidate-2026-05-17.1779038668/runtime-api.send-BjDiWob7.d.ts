import { i as OpenClawConfig } from "./types.openclaw-D8bJSZjd.js";
import { S as MarkdownTableMode } from "./types.base-YD5s4YZy.js";
import { t as OutboundMediaAccess } from "./load-options-Bp5CKOxS.js";
import { d as ChunkMode } from "./outbound.types-GcP9rxun.js";
import { t as RequestClient } from "./rest-BTu1zfHF.js";
import { d as DiscordComponentBuildResult, h as DiscordComponentMessageSpec } from "./components-mMzuDxlK.js";
import { v as DiscordSendResult } from "./send.types-Dr9hc4Iw.js";

//#region extensions/discord/src/send.components.d.ts
type DiscordComponentSendOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  silent?: boolean;
  replyTo?: string;
  sessionKey?: string;
  agentId?: string;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  filename?: string;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  suppressEmbeds?: boolean;
};
declare function registerBuiltDiscordComponentMessage(params: {
  buildResult: DiscordComponentBuildResult;
  messageId: string;
}): void;
declare function sendDiscordComponentMessage(to: string, spec: DiscordComponentMessageSpec, opts: DiscordComponentSendOpts): Promise<DiscordSendResult>;
declare function editDiscordComponentMessage(to: string, messageId: string, spec: DiscordComponentMessageSpec, opts: DiscordComponentSendOpts): Promise<DiscordSendResult>;
//#endregion
export { registerBuiltDiscordComponentMessage as n, sendDiscordComponentMessage as r, editDiscordComponentMessage as t };