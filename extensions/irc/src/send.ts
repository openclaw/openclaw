import type { IrcClient } from "./client.js";
import type { CoreConfig } from "./types.js";
import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient } from "./client.js";
import { normalizeIrcMessagingTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";

type SendIrcOptions = {
  accountId?: string;
  replyTo?: string;
  target?: string;
  client?: IrcClient;
};

export type SendIrcResult = {
  messageId: string;
  target: string;
};

function resolveTarget(to: string, opts?: SendIrcOptions): string {
  const fromArg = normalizeIrcMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeIrcMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid IRC target: ${to}`);
}

export async function sendMessageIrc(
  to: string,
  text: string,
  opts: SendIrcOptions = {},
): Promise<SendIrcResult> {
  const runtime = getIrcRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const target = resolveTarget(to, opts);
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "irc",
    accountId: account.accountId,
  });
  const prepared = runtime.channel.text.convertMarkdownTables(text.trim(), tableMode);
  const payload = opts.replyTo ? `${prepared}\n\n[reply:${opts.replyTo}]` : prepared;

  if (!payload.trim()) {
    throw new Error("Message must be non-empty for IRC sends");
  }

  const client = opts.client;
  if (client?.isReady()) {
    client.sendPrivmsg(target, payload);
  } else {
    const transient = await connectIrcClient({
      host: account.host,
      port: account.port,
      tls: account.tls,
      nick: account.nick,
      username: account.username,
      realname: account.realname,
      password: account.password,
      nickserv: {
        enabled: account.config.nickserv?.enabled,
        service: account.config.nickserv?.service,
        password: account.config.nickserv?.password,
        register: account.config.nickserv?.register,
        registerEmail: account.config.nickserv?.registerEmail,
      },
      connectTimeoutMs: 12000,
    });
    transient.sendPrivmsg(target, payload);
    transient.quit("sent");
  }

  runtime.channel.activity.record({
    channel: "irc",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: makeIrcMessageId(),
    target,
  };
}
