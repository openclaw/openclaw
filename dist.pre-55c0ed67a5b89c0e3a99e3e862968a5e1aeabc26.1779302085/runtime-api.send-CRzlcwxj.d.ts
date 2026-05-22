import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { S as MarkdownTableMode } from "./types.base-DS--yneR.js";
import { t as OutboundMediaAccess } from "./load-options-CTuppEe4.js";
import { f as ChunkMode } from "./outbound.types-CEuSkQTG.js";
import { t as RequestClient } from "./rest-CE8PF7Nu.js";
import { d as DiscordComponentBuildResult, h as DiscordComponentMessageSpec } from "./components-CTSfosYK.js";
import { v as DiscordSendResult } from "./send.types-BwE_Y3k4.js";

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