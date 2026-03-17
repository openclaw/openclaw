import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { normalizeIrcMessagingTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";
function resolveTarget(to, opts) {
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
async function sendMessageIrc(to, text, opts = {}) {
  const runtime = getIrcRuntime();
  const cfg = opts.cfg ?? runtime.config.loadConfig();
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId
  });
  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`
    );
  }
  const target = resolveTarget(to, opts);
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "irc",
    accountId: account.accountId
  });
  const prepared = runtime.channel.text.convertMarkdownTables(text.trim(), tableMode);
  const payload = opts.replyTo ? `${prepared}

[reply:${opts.replyTo}]` : prepared;
  if (!payload.trim()) {
    throw new Error("Message must be non-empty for IRC sends");
  }
  const client = opts.client;
  if (client?.isReady()) {
    client.sendPrivmsg(target, payload);
  } else {
    const transient = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: 12e3
      })
    );
    transient.sendPrivmsg(target, payload);
    transient.quit("sent");
  }
  runtime.channel.activity.record({
    channel: "irc",
    accountId: account.accountId,
    direction: "outbound"
  });
  return {
    messageId: makeIrcMessageId(),
    target
  };
}
export {
  sendMessageIrc
};
