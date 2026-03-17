import { createReplyPrefixOptions } from "openclaw/plugin-sdk/twitch";
import { checkTwitchAccessControl } from "./access-control.js";
import { getOrCreateClientManager } from "./client-manager-registry.js";
import { getTwitchRuntime } from "./runtime.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";
async function processTwitchMessage(params) {
  const { message, account, accountId, config, runtime, core, statusSink } = params;
  const cfg = config;
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "twitch",
    accountId,
    peer: {
      kind: "group",
      // Twitch chat is always group-like
      id: message.channel
    }
  });
  const rawBody = message.message;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Twitch",
    from: message.displayName ?? message.username,
    timestamp: message.timestamp?.getTime(),
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: rawBody
  });
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `twitch:user:${message.userId}`,
    To: `twitch:channel:${message.channel}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: message.channel,
    SenderName: message.displayName ?? message.username,
    SenderId: message.userId,
    SenderUsername: message.username,
    Provider: "twitch",
    Surface: "twitch",
    MessageSid: message.id,
    OriginatingChannel: "twitch",
    OriginatingTo: `twitch:channel:${message.channel}`
  });
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId
  });
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`Failed updating session meta: ${String(err)}`);
    }
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "twitch",
    accountId
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "twitch",
    accountId
  });
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverTwitchReply({
          payload,
          channel: message.channel,
          account,
          accountId,
          config,
          tableMode,
          runtime,
          statusSink
        });
      }
    },
    replyOptions: {
      onModelSelected
    }
  });
}
async function deliverTwitchReply(params) {
  const { payload, channel, account, accountId, config, runtime, statusSink } = params;
  try {
    const clientManager = getOrCreateClientManager(accountId, {
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
      error: (msg) => runtime.error?.(msg),
      debug: (msg) => runtime.log?.(msg)
    });
    const client = await clientManager.getClient(
      account,
      config,
      accountId
    );
    if (!client) {
      runtime.error?.(`No client available for sending reply`);
      return;
    }
    if (!payload.text) {
      runtime.error?.(`No text to send in reply payload`);
      return;
    }
    const textToSend = stripMarkdownForTwitch(payload.text);
    await client.say(channel, textToSend);
    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (err) {
    runtime.error?.(`Failed to send reply: ${String(err)}`);
  }
}
async function monitorTwitchProvider(options) {
  const { account, accountId, config, runtime, abortSignal, statusSink } = options;
  const core = getTwitchRuntime();
  let stopped = false;
  const coreLogger = core.logging.getChildLogger({ module: "twitch" });
  const logVerboseMessage = (message) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    coreLogger.debug?.(message);
  };
  const logger = {
    info: (msg) => coreLogger.info(msg),
    warn: (msg) => coreLogger.warn(msg),
    error: (msg) => coreLogger.error(msg),
    debug: logVerboseMessage
  };
  const clientManager = getOrCreateClientManager(accountId, logger);
  try {
    await clientManager.getClient(
      account,
      config,
      accountId
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.error?.(`Failed to connect: ${errorMsg}`);
    throw error;
  }
  const unregisterHandler = clientManager.onMessage(account, (message) => {
    if (stopped) {
      return;
    }
    const botUsername = account.username.toLowerCase();
    if (message.username.toLowerCase() === botUsername) {
      return;
    }
    const access = checkTwitchAccessControl({
      message,
      account,
      botUsername
    });
    if (!access.allowed) {
      return;
    }
    statusSink?.({ lastInboundAt: Date.now() });
    void processTwitchMessage({
      message,
      account,
      accountId,
      config,
      runtime,
      core,
      statusSink
    }).catch((err) => {
      runtime.error?.(`Message processing failed: ${String(err)}`);
    });
  });
  const stop = () => {
    stopped = true;
    unregisterHandler();
  };
  abortSignal.addEventListener("abort", stop, { once: true });
  return { stop };
}
export {
  monitorTwitchProvider
};
