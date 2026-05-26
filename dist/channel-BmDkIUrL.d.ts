import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/clickclack/src/types.d.ts
type ClickClackAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  token?: unknown;
  workspace?: string;
  botUserId?: string;
  agentId?: string;
  replyMode?: "agent" | "model";
  model?: string;
  systemPrompt?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  defaultTo?: string;
  allowFrom?: string[];
  reconnectMs?: number;
};
type ClickClackConfig = ClickClackAccountConfig & {
  accounts?: Record<string, Partial<ClickClackAccountConfig>>;
  defaultAccount?: string;
};
type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    clickclack?: ClickClackConfig;
  };
};
type ResolvedClickClackAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  token: string;
  workspace: string;
  botUserId?: string;
  agentId?: string;
  replyMode: "agent" | "model";
  model?: string;
  systemPrompt?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  defaultTo: string;
  allowFrom: string[];
  reconnectMs: number;
  config: ClickClackAccountConfig;
};
type ClickClackUser = {
  id: string;
  kind?: "human" | "bot";
  owner_user_id?: string;
  display_name: string;
  handle: string;
  avatar_url: string;
  created_at: string;
};
type ClickClackWorkspace = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};
type ClickClackChannel = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  created_at: string;
};
type ClickClackMessage = {
  id: string;
  workspace_id: string;
  channel_id?: string;
  direct_conversation_id?: string;
  author_id: string;
  parent_message_id?: string;
  thread_root_id: string;
  channel_seq?: number;
  thread_seq?: number;
  body: string;
  body_format: "markdown";
  created_at: string;
  author?: ClickClackUser;
};
type ClickClackEvent = {
  id: string;
  cursor: string;
  type: string;
  workspace_id: string;
  channel_id?: string;
  seq?: number;
  created_at: string;
  payload: Record<string, unknown>;
};
type ClickClackTarget = {
  chatType: "group";
  kind: "channel";
  id: string;
} | {
  chatType: "group";
  kind: "thread";
  id: string;
} | {
  chatType: "direct";
  kind: "dm";
  id: string;
};
//#endregion
//#region extensions/clickclack/src/channel.d.ts
declare const clickClackPlugin: ChannelPlugin<ResolvedClickClackAccount>;
//#endregion
export { ClickClackMessage as a, ClickClackWorkspace as c, ClickClackEvent as i, CoreConfig as l, ClickClackAccountConfig as n, ClickClackTarget as o, ClickClackChannel as r, ClickClackUser as s, clickClackPlugin as t, ResolvedClickClackAccount as u };