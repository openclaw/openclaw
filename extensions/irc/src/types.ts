// Irc type declarations define plugin contracts.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { IrcAccountConfigInput } from "./config-schema.js";

export type IrcChannelConfig = NonNullable<NonNullable<IrcAccountConfigInput["groups"]>[string]>;
export type IrcNickServConfig = NonNullable<IrcAccountConfigInput["nickserv"]>;
export type IrcAccountConfig = Omit<IrcAccountConfigInput, "groups"> & {
  defaultTo?: string;
  groups?: Record<string, IrcChannelConfig>;
};

type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
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

export type IrcProbe = BaseProbeResult<string> & {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  latencyMs?: number;
};
