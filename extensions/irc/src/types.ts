import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type IrcChannelConfig = {
  requireMention?: boolean;
  tools?: unknown;
  toolsBySender?: Record<string, unknown>;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type IrcNickServConfig = {
  enabled?: boolean;
  service?: string;
  password?: string;
  passwordFile?: string;
  register?: boolean;
  registerEmail?: string;
};

export type IrcAccountConfig = {
  name?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  password?: string;
  passwordFile?: string;
  nickserv?: IrcNickServConfig;
  dmPolicy?: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, IrcChannelConfig>;
  channels?: string[];
  mentionPatterns?: string[];
  markdown?: {
    enabled?: boolean;
    tables?: {
      mode?: "code" | "plain";
    };
  };
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<
    string,
    {
      tools?: unknown;
      skills?: string[];
      systemPrompt?: string;
    }
  >;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: {
    minChars?: number;
    idleMs?: number;
  };
  responsePrefix?: string;
  mediaMaxMb?: number;
};

export type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    irc?: IrcConfig;
  };
};

export type IrcInboundMessage = {
  messageId: string;
  /** Conversation peer id: channel name for groups, sender nick for DMs. */
  target: string;
  /** Raw IRC PRIVMSG target (bot nick for DMs, channel for groups). */
  rawTarget?: string;
  senderNick: string;
  senderUser?: string;
  senderHost?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
};

export type IrcProbe = {
  ok: boolean;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  latencyMs?: number;
  error?: string;
};
