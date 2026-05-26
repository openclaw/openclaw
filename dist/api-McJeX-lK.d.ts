import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as ChannelConfigSchema } from "./types.config-CKJTcS4X.js";
import { n as PluginRuntime } from "./types-DpjQFFwi.js";
import { a as ClickClackMessage, c as ClickClackWorkspace, i as ClickClackEvent, l as CoreConfig, o as ClickClackTarget, r as ClickClackChannel, s as ClickClackUser, u as ResolvedClickClackAccount } from "./channel-BmDkIUrL.js";
import { WebSocket as WebSocket$1 } from "ws";

//#region extensions/clickclack/src/accounts.d.ts
declare const listClickClackAccountIds: (cfg: OpenClawConfig) => string[], resolveDefaultClickClackAccountId: (cfg: OpenClawConfig) => string;
declare function resolveClickClackAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedClickClackAccount;
declare function listEnabledClickClackAccounts(cfg: CoreConfig): ResolvedClickClackAccount[];
//#endregion
//#region extensions/clickclack/src/config-schema.d.ts
declare const clickClackConfigSchema: ChannelConfigSchema;
//#endregion
//#region extensions/clickclack/src/http-client.d.ts
type ClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
};
declare function createClickClackClient(options: ClientOptions): {
  me: () => Promise<ClickClackUser>;
  workspaces: () => Promise<ClickClackWorkspace[]>;
  channels: (workspaceId: string) => Promise<ClickClackChannel[]>;
  channelMessages: (channelId: string, afterSeq: number, limit?: number) => Promise<ClickClackMessage[]>;
  directMessages: (conversationId: string, afterSeq: number, limit?: number) => Promise<ClickClackMessage[]>;
  thread: (messageId: string) => Promise<{
    root: ClickClackMessage;
    replies: ClickClackMessage[];
  }>;
  createChannelMessage: (channelId: string, body: string) => Promise<ClickClackMessage>;
  createThreadReply: (messageId: string, body: string) => Promise<ClickClackMessage>;
  createDirectConversation: (workspaceId: string, memberIds: string[]) => Promise<{
    id: string;
  }>;
  createDirectMessage: (conversationId: string, body: string) => Promise<ClickClackMessage>;
  events: (workspaceId: string, afterCursor?: string) => Promise<ClickClackEvent[]>;
  websocket: (workspaceId: string, afterCursor?: string) => WebSocket$1;
};
//#endregion
//#region extensions/clickclack/src/runtime.d.ts
declare const setClickClackRuntime: (next: PluginRuntime) => void, getClickClackRuntime: () => PluginRuntime;
//#endregion
//#region extensions/clickclack/src/target.d.ts
declare function parseClickClackTarget(raw: string): ClickClackTarget;
declare function buildClickClackTarget(target: ClickClackTarget): string;
//#endregion
export { createClickClackClient as a, listEnabledClickClackAccounts as c, setClickClackRuntime as i, resolveClickClackAccount as l, parseClickClackTarget as n, clickClackConfigSchema as o, getClickClackRuntime as r, listClickClackAccountIds as s, buildClickClackTarget as t, resolveDefaultClickClackAccountId as u };