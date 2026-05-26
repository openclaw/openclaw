import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { S as MarkdownTableMode } from "./types.base-DCoxbfrn.js";
import { t as OutboundMediaAccess } from "./load-options-Dc-kAx-U.js";
import { d as ChunkMode } from "./outbound.types-COmT4EQP.js";
import { t as RequestClient } from "./rest-B-RZEvtD.js";
import { d as DiscordComponentBuildResult, h as DiscordComponentMessageSpec } from "./components-DwVj3nrc.js";
import { v as DiscordSendResult } from "./send.types-JrVv9jdV.js";

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
};
declare function registerBuiltDiscordComponentMessage(params: {
  buildResult: DiscordComponentBuildResult;
  messageId: string;
}): void;
declare function sendDiscordComponentMessage(to: string, spec: DiscordComponentMessageSpec, opts: DiscordComponentSendOpts): Promise<DiscordSendResult>;
declare function editDiscordComponentMessage(to: string, messageId: string, spec: DiscordComponentMessageSpec, opts: DiscordComponentSendOpts): Promise<DiscordSendResult>;
//#endregion
export { registerBuiltDiscordComponentMessage as n, sendDiscordComponentMessage as r, editDiscordComponentMessage as t };