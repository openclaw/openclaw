import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { S as MarkdownTableMode } from "./types.base-BgiAX4pP.js";
import { t as OutboundMediaAccess } from "./load-options-3S8eYy30.js";
import { d as ChunkMode } from "./outbound.types-CYxlkHkP.js";
import { t as RequestClient } from "./rest-qrUgLPJI.js";
import { d as DiscordComponentBuildResult, h as DiscordComponentMessageSpec } from "./components-rwmUDqbj.js";
import { v as DiscordSendResult } from "./send.types-CQiyWXO1.js";

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