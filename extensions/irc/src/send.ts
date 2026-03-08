import { resolveIrcAccount } from "./accounts.js";
import { getLiveIrcClient } from "./client-registry.js";
import type { IrcClient } from "./client.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { normalizeIrcMessagingTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendIrcOptions = {
  cfg?: CoreConfig;
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
  // Use caller-provided config snapshot when available (e.g. staged mutations,
  // alternate account snapshots). Fall back to loading from runtime only when
  // no cfg is supplied so that callers like the outbound channel path (which
  // always passes cfg explicitly) get deterministic behaviour without a
  // config reload race.
  const cfg = opts.cfg ?? (runtime.config.loadConfig() as CoreConfig);
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

  // Prefer a caller-supplied client, then the monitor's live registered
  // client, and only fall back to a transient connection if neither exists.
  // This avoids opening duplicate connections with the same nick (IRC 433).
  const client = opts.client ?? getLiveIrcClient(account.accountId);
  if (client?.isReady()) {
    client.sendPrivmsg(target, payload);
  } else {
    const transient = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: 12000,
      }),
    );
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
