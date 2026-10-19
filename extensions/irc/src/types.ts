import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { IrcAccountConfigInput } from "./config-schema.js";

export type IrcChannelConfig = NonNullable<NonNullable<IrcAccountConfigInput["groups"]>[string]>;
export type IrcNickServConfig = NonNullable<IrcAccountConfigInput["nickserv"]>;
/** NickServ settings after account resolution: the password leaf is already a literal string. */
export type ResolvedIrcNickServConfig = Omit<IrcNickServConfig, "password"> & {
  password?: string;
};
export type IrcAccountConfig = Omit<IrcAccountConfigInput, "groups"> & {
  defaultTo?: string;
  groups?: Record<string, IrcChannelConfig>;
};

type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
};

// Core types the secret leaves as `SecretInput`, which is wider than the literal-ref union the
// zod schema infers. Intersecting both would demand the wider core value satisfy the narrower
// union, so the secret leaves come from the core contract and the plugin type owns the rest.
type CoreIrcConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["irc"]>;
type IrcSecretLeafKeys = "password" | "nickserv";

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    irc?: CoreIrcConfig &
      Omit<IrcConfig, "accounts" | IrcSecretLeafKeys> & {
        accounts?: Record<string, Omit<IrcAccountConfig, IrcSecretLeafKeys>>;
      };
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
