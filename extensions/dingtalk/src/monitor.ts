import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { DWClient, DWClientDownStream, EventAck, TOPIC_ROBOT, type RobotTextMessage } from "dingtalk-stream";
import { getDingTalkRuntime } from "./runtime.js";
import { resolveDingTalkCredentials } from "./token.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

export type MonitorDingTalkOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorDingTalkResult = {
  shutdown: () => Promise<void>;
};

/**
 * Monitor DingTalk provider using Stream Mode (WebSocket).
 *
 * This connects to DingTalk's stream API using the official dingtalk-stream SDK.
 * Stream mode doesn't require a public URL/webhook - it uses WebSocket connections.
 */
export async function monitorDingTalkProvider(
  opts: MonitorDingTalkOpts,
): Promise<MonitorDingTalkResult> {
  const core = getDingTalkRuntime();
  const log = core.logging.getChildLogger({ name: "dingtalk" });
  let cfg = opts.cfg;
  let dingtalkCfg = cfg.channels?.dingtalk;
  if (!dingtalkCfg?.enabled) {
    log.debug("dingtalk provider disabled");
    return { shutdown: async () => {} };
  }

  const creds = resolveDingTalkCredentials(dingtalkCfg);
  if (!creds) {
    log.error("dingtalk credentials not configured");
    return { shutdown: async () => {} };
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const accountId = DEFAULT_ACCOUNT_ID;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "dingtalk");
  const MB = 1024 * 1024;
  const agentDefaults = cfg.agents?.defaults;
  const mediaMaxBytes =
    typeof agentDefaults?.mediaMaxMb === "number" && agentDefaults.mediaMaxMb > 0
      ? Math.floor(agentDefaults.mediaMaxMb * MB)
      : 20 * MB; // Default 20MB for DingTalk

  // Initialize DingTalk Stream Client with auto-reconnect enabled
  const client = new DWClient({
    clientId: creds.appKey,
    clientSecret: creds.appSecret,
    keepAlive: true,
    debug: false,
    // autoReconnect is true by default, but we explicitly set it for clarity
  });

  let statusSink: ((patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void) | undefined;
  let connectionWatchdog: NodeJS.Timeout | null = null;
  let wasConnected = false;
  let reconnectAttempts = 0;

  // Process incoming DingTalk message
  async function processDingTalkMessage(
    message: RobotTextMessage,
    messageId: string,
  ): Promise<void> {
    try {
      const conversationId = message.conversationId;
      const conversationType = message.conversationType;
      const isGroup = conversationType === "2"; // "1" = DM, "2" = group
      const senderId = message.senderStaffId || message.senderId;
      const senderName = message.senderNick;
      const rawBody = message.text?.content || "";
      const timestamp = message.createAt;
      const sessionWebhook = message.sessionWebhook; // Store for reply

      if (!rawBody.trim()) {
        log.debug("skipping empty message");
        return;
      }

      // Access control: check group policy
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = dingtalkCfg?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

      if (isGroup) {
        if (groupPolicy === "disabled") {
          log.debug(`dropping group message from ${conversationId} (groupPolicy: disabled)`);
          return;
        }

        if (groupPolicy === "allowlist") {
          const groupAllowFrom = dingtalkCfg?.groupAllowFrom ?? dingtalkCfg?.allowFrom ?? [];
          const hasWildcard = groupAllowFrom.includes("*");
          const normalizedGroupAllowFrom = groupAllowFrom
            .filter((entry) => entry !== "*")
            .map((entry) => String(entry).trim().toLowerCase());

          const senderAllowed =
            hasWildcard ||
            (senderId && normalizedGroupAllowFrom.includes(senderId.toLowerCase()));

          if (!senderAllowed) {
            log.debug(
              `dropping group message from ${senderId} in ${conversationId} (not in allowlist)`,
            );
            return;
          }
        }
      }

      // Resolve agent route first (needed for mention checking)
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup ? conversationId : senderId,
        },
      });

      // Check mention requirement for groups
      let wasMentioned = false;
      if (isGroup) {
        const groupConfig = dingtalkCfg?.groups?.[conversationId];
        const wildcardConfig = dingtalkCfg?.groups?.["*"];
        const channelConfig = groupConfig?.channels?.[conversationId];

        const requireMention =
          channelConfig?.requireMention ??
          groupConfig?.requireMention ??
          wildcardConfig?.requireMention ??
          dingtalkCfg?.requireMention ??
          true;

        if (requireMention) {
          const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
          wasMentioned = mentionRegexes.length
            ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
            : false;

          if (!wasMentioned) {
            log.debug(`dropping group message from ${conversationId} (no mention)`);
            return;
          }
        }
      }

      // Format message envelope
      const fromLabel = isGroup
        ? `group:${conversationId}`
        : senderName || `user:${senderId}`;
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "DingTalk",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      });

      // Build message context
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: isGroup ? `dingtalk:group:${conversationId}` : `dingtalk:${senderId}`,
        To: `dingtalk:${conversationId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: senderName || undefined,
        SenderId: senderId,
        GroupSubject: isGroup ? conversationId : undefined,
        Provider: "dingtalk",
        Surface: "dingtalk",
        WasMentioned: isGroup ? wasMentioned : undefined,
        MessageSid: messageId,
        Timestamp: timestamp,
        OriginatingChannel: "dingtalk",
        OriginatingTo: `dingtalk:${conversationId}`,
      });

      // Record inbound session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
      });

      statusSink?.({ lastInboundAt: Date.now() });

      // Create reply dispatcher using createReplyDispatcherWithTyping (no typing needed)
      const { dispatcher } = core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload) => {
          const { sendMessageDingTalk } = await import("./send.js");
          
          // Extract text from payload
          const text = payload.text || "";
          if (text) {
            await sendMessageDingTalk({
              cfg,
              to: isGroup ? conversationId : senderId,
              text,
              sessionWebhook, // Use sessionWebhook for reply
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          }

          // Handle media if present
          if (payload.mediaUrl || payload.mediaUrls?.length) {
            log.warn("media sending not yet implemented for DingTalk");
          }
        },
        onError: (err, info) => {
          log.error(`dingtalk ${info.kind} reply failed`, { error: String(err) });
          runtime.error?.(`dingtalk ${info.kind} reply failed: ${String(err)}`);
        },
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      });

      // Dispatch reply
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
      });

      log.debug(`processed message from ${senderId} in ${isGroup ? "group" : "DM"} ${conversationId}`);
    } catch (err) {
      log.error("failed to process DingTalk message", { error: String(err) });
      runtime.error?.(`dingtalk message processing error: ${String(err)}`);
    }
  }

  // Register robot message callback
  client.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
    try {
      log.debug("received robot message callback");
      const messageData = JSON.parse(res.data) as RobotTextMessage;

      // Only process text messages for now
      if (messageData.msgtype !== "text") {
        log.debug(`skipping non-text message type: ${messageData.msgtype}`);
        return;
      }

      await processDingTalkMessage(messageData, res.headers.messageId);

      // Acknowledge message to prevent retries
      client.socketCallBackResponse(res.headers.messageId, { response: "OK" });
    } catch (err) {
      log.error("failed to handle robot callback", { error: String(err) });
      runtime.error?.(`dingtalk callback error: ${String(err)}`);
    }
  });

  // Register all event listener (required for stream mode)
  client.registerAllEventListener((message: DWClientDownStream) => {
    return { status: EventAck.SUCCESS };
  });

  // Connection watchdog: monitor connection state and log reconnection events
  // This helps detect when the connection is lost (e.g., machine sleep) and reconnected
  const startConnectionWatchdog = () => {
    if (connectionWatchdog) {
      clearInterval(connectionWatchdog);
    }
    connectionWatchdog = setInterval(() => {
      const isConnected = (client as { connected?: boolean }).connected ?? false;
      const isReconnecting = (client as { reconnecting?: boolean }).reconnecting ?? false;

      if (isConnected && !wasConnected) {
        // Connection established or reconnected
        if (wasConnected === false && reconnectAttempts > 0) {
          log.info(`DingTalk connection reestablished after ${reconnectAttempts} attempt(s)`);
          runtime.log?.(`DingTalk reconnected successfully`);
          reconnectAttempts = 0;
        }
        wasConnected = true;
      } else if (!isConnected && wasConnected) {
        // Connection lost
        log.warn("DingTalk connection lost, waiting for automatic reconnection...");
        runtime.error?.("DingTalk connection lost; automatic reconnection in progress");
        wasConnected = false;
        reconnectAttempts += 1;
      } else if (isReconnecting && reconnectAttempts > 0) {
        // Reconnection in progress
        log.debug(`DingTalk reconnection attempt ${reconnectAttempts} in progress...`);
      }
    }, 5000); // Check every 5 seconds
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      log.info("abort signal received, disconnecting DingTalk client");
      if (connectionWatchdog) {
        clearInterval(connectionWatchdog);
        connectionWatchdog = null;
      }
      client.disconnect();
    });
  }

  // Connect to DingTalk Stream
  try {
    log.info("connecting to DingTalk Stream API...");
    await client.connect();
    wasConnected = true;
    log.info("DingTalk monitor started (stream mode)");
    
    // Start connection watchdog after initial connection
    startConnectionWatchdog();
  } catch (err) {
    log.error("failed to connect to DingTalk Stream", { error: String(err) });
    runtime.error?.(`dingtalk connection error: ${String(err)}`);
    throw err;
  }

  return {
    shutdown: async () => {
      log.info("shutting down DingTalk monitor");
      try {
        if (connectionWatchdog) {
          clearInterval(connectionWatchdog);
          connectionWatchdog = null;
        }
        client.disconnect();
        log.info("DingTalk monitor stopped");
      } catch (err) {
        log.error("error during DingTalk shutdown", { error: String(err) });
      }
    },
  };
}
