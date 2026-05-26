import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { _ as GroupPolicy, h as DmPolicy, r as BlockStreamingCoalesceConfig, x as MarkdownConfig } from "./types.base-DS--yneR.js";
import { a as GroupToolPolicyBySenderConfig, o as GroupToolPolicyConfig } from "./types.tools-BpgZArJS.js";
import { an as DmConfig } from "./types.channels-C67UBRPK.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/irc/src/types.d.ts
type IrcChannelConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};
type IrcNickServConfig = {
  enabled?: boolean;
  service?: string;
  password?: string;
  passwordFile?: string;
  register?: boolean;
  registerEmail?: string;
};
type IrcAccountConfig = {
  name?: string;
  enabled?: boolean;
  /**
   * Break-glass override: allow nick-only allowlist matching.
   * Default behavior requires host/user-qualified identities.
   */
  dangerouslyAllowNameMatching?: boolean;
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  password?: string;
  passwordFile?: string;
  nickserv?: IrcNickServConfig;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, IrcChannelConfig>;
  channels?: string[];
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
  mediaMaxMb?: number;
};
type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
};
type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    irc?: IrcConfig;
  };
};
type IrcProbe = BaseProbeResult<string> & {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  latencyMs?: number;
};
//#endregion
//#region extensions/irc/src/accounts.d.ts
type ResolvedIrcAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password: string;
  passwordSource: "env" | "passwordFile" | "config" | "none";
  config: IrcAccountConfig;
};
declare const listIrcAccountIds: (cfg: OpenClawConfig) => string[], resolveDefaultIrcAccountId: (cfg: OpenClawConfig) => string;
declare function resolveIrcAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedIrcAccount;
declare function listEnabledIrcAccounts(cfg: CoreConfig): ResolvedIrcAccount[];
//#endregion
//#region extensions/irc/src/channel.d.ts
declare const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe>;
//#endregion
export { resolveDefaultIrcAccountId as a, listIrcAccountIds as i, ResolvedIrcAccount as n, resolveIrcAccount as o, listEnabledIrcAccounts as r, ircPlugin as t };