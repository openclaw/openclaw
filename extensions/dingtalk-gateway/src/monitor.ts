import type { RobotTextMessage } from "dingtalk-stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { getDingTalkGatewayRuntime } from "./runtime.js";
import { createKafkaClient, type KafkaClient } from "./kafka.js";

export type MonitorDingTalkGatewayOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId: string;
  userId: string;
  kafkaBrokers?: string | string[];
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type MonitorDingTalkGatewayResult = {
  kafkaClient: KafkaClient;
};

export async function monitorDingTalkGatewayProvider(
  opts: MonitorDingTalkGatewayOpts,
): Promise<MonitorDingTalkGatewayResult> {
  const { accountId, userId, kafkaBrokers, cfg, runtime, statusSink, abortSignal } = opts;
  const core = getDingTalkGatewayRuntime();
  const log = core.logging.getChildLogger({ name: "dingtalk-gateway" });
  const dingtalkGatewayCfg = cfg.channels?.["dingtalk-gateway"];

  // Built-in topic and group ID based on userId
  const kafkaGroupId = `dingtalk-user-${userId}-consumer`;
  const inboundTopic = `dingtalk-user-${userId}`;
  const outboundTopic = `dingtalk-reply-${userId}`;

  // Create Kafka client
  const kafkaClient = createKafkaClient({
    brokers: kafkaBrokers || "localhost:9092",
    groupId: kafkaGroupId,
    inboundTopic,
    outboundTopic,
    log,
  });

  await kafkaClient.connect();

  // Subscribe to inbound topic
  await kafkaClient.consumer.subscribe({
    topic: inboundTopic,
    fromBeginning: false,
  });

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
        log.debug("skipping empty message", { messageId, conversationId });
        return;
      }

      // Access control: check DM policy
      const dmPolicy = dingtalkGatewayCfg?.dmPolicy ?? "pairing";
      const allowFrom = dingtalkGatewayCfg?.allowFrom ?? [];
      const hasWildcard = allowFrom.includes("*");
      const normalizedAllowFrom = allowFrom
        .filter((entry) => entry !== "*")
        .map((entry) => String(entry).trim().toLowerCase());

      const senderAllowed =
        hasWildcard || (senderId && normalizedAllowFrom.includes(senderId.toLowerCase()));

      if (!isGroup) {
        // DM access control
        if (dmPolicy === "disabled") {
          log.debug(`dropping DM from ${senderId} (dmPolicy: disabled)`, { messageId });
          return;
        }

        if (dmPolicy !== "open" && !senderAllowed) {
          if (dmPolicy === "pairing") {
            const { code, created } = await core.channel.pairing.upsertPairingRequest({
              channel: "dingtalk-gateway",
              id: senderId,
              meta: { name: senderName },
            });
            if (created) {
              log.info(`dingtalk-gateway pairing request sender=${senderId} code=${code}`);
              try {
                const { sendMessageDingTalkGateway } = await import("./send.js");
                await sendMessageDingTalkGateway({
                  cfg,
                  to: senderId,
                  text: core.channel.pairing.buildPairingReply({
                    channel: "dingtalk-gateway",
                    idLine: `Your DingTalk user id: ${senderId}`,
                    code,
                  }),
                  kafkaClient,
                  outboundTopic,
                });
                statusSink?.({ lastOutboundAt: Date.now() });
              } catch (err) {
                log.error(`dingtalk-gateway pairing reply failed for ${senderId}`, {
                  error: String(err),
                });
              }
            }
          } else {
            log.debug(`dropping DM from ${senderId} (dmPolicy=${dmPolicy}, not in allowlist)`);
          }
          return;
        }
      }

      // Access control: check group policy
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = dingtalkGatewayCfg?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

      if (isGroup) {
        if (groupPolicy === "disabled") {
          log.debug(`dropping group message from ${conversationId} (groupPolicy: disabled)`, {
            messageId,
          });
          return;
        }

        if (groupPolicy === "allowlist") {
          const groupAllowFrom = dingtalkGatewayCfg?.groupAllowFrom ?? dingtalkGatewayCfg?.allowFrom ?? [];
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
        channel: "dingtalk-gateway",
        accountId,
        peer: {
          kind: isGroup ? "group" : "dm",
          id: isGroup ? conversationId : senderId,
        },
      });
      
      log.info("processing message", {
        messageId,
        agentId: route.agentId,
        senderId,
        conversationId,
        isGroup,
      });

      // Check mention requirement for groups
      let wasMentioned = false;
      if (isGroup) {
        const groupConfig = dingtalkGatewayCfg?.groups?.[conversationId];
        const wildcardConfig = dingtalkGatewayCfg?.groups?.["*"];
        const channelConfig = groupConfig?.channels?.[conversationId];

        const requireMention =
          channelConfig?.requireMention ??
          groupConfig?.requireMention ??
          wildcardConfig?.requireMention ??
          dingtalkGatewayCfg?.requireMention ??
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
        channel: "DingTalk Gateway",
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
        From: isGroup ? `dingtalk-gateway:group:${conversationId}` : `dingtalk-gateway:${senderId}`,
        To: `dingtalk-gateway:${conversationId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: senderName || undefined,
        SenderId: senderId,
        GroupSubject: isGroup ? conversationId : undefined,
        Provider: "dingtalk-gateway",
        Surface: "dingtalk-gateway",
        WasMentioned: isGroup ? wasMentioned : undefined,
        MessageSid: messageId,
        Timestamp: timestamp,
        OriginatingChannel: "dingtalk-gateway",
        OriginatingTo: `dingtalk-gateway:${conversationId}`,
      });

      // Record inbound session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
      });

      statusSink?.({ lastInboundAt: Date.now() });

      // Create reply dispatcher using createReplyDispatcherWithTyping
      const { dispatcher } = core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload) => {
          const { sendMessageDingTalkGateway } = await import("./send.js");

          // Extract text from payload
          const text = payload.text || "";
          if (text) {
            log.info("sending reply message", {
              messageId,
              to: isGroup ? conversationId : senderId,
              textLength: text.length,
            });
            await sendMessageDingTalkGateway({
              cfg,
              to: isGroup ? conversationId : senderId,
              text,
              sessionWebhook, // Store sessionWebhook for reply context
              kafkaClient,
              outboundTopic,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } else {
            log.warn("reply payload has no text content", { messageId });
          }

          // Handle media if present
          if (payload.mediaUrl || payload.mediaUrls?.length) {
            log.warn("media sending not yet implemented for DingTalk Gateway", {
              messageId,
              mediaUrl: payload.mediaUrl,
              mediaUrlsCount: payload.mediaUrls?.length || 0,
            });
          }
        },
        onError: (err, info) => {
          log.error(`dingtalk-gateway ${info.kind} reply failed`, {
            error: String(err),
            stack: err instanceof Error ? err.stack : undefined,
            messageId,
            kind: info.kind,
          });
          runtime.error?.(`dingtalk-gateway ${info.kind} reply failed: ${String(err)}`);
        },
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      });

      // Dispatch reply
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
      });
    } catch (err) {
      log.error("failed to process DingTalk Gateway message", {
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
        messageId,
      });
      runtime.error?.(`dingtalk-gateway message processing error: ${String(err)}`);
      throw err; // Re-throw to let caller handle it
    }
  }

  // Start consuming messages
  await kafkaClient.consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        if (!message.value) {
          log.debug("skipping message with no value");
          return;
        }

        let messageData: RobotTextMessage;
        try {
          const rawValue = message.value.toString();
          const parsed = JSON.parse(rawValue);
          
          // Handle wrapped message format: { data: RobotTextMessage, ... }
          // The actual RobotTextMessage is in the 'data' field
          if (parsed.data && typeof parsed.data === "object") {
            messageData = parsed.data as RobotTextMessage;
          } else {
            // Assume it's already in RobotTextMessage format
            messageData = parsed as RobotTextMessage;
          }
        } catch (parseErr) {
          log.error("failed to parse message JSON", {
            error: String(parseErr),
            topic,
            partition,
            rawValue: message.value.toString().substring(0, 500),
          });
          return;
        }

        // Extract messageId from headers or data
        const messageId =
          message.headers?.messageId?.toString() ||
          messageData.msgId ||
          `${topic}-${partition}-${message.offset}`;

        await processDingTalkMessage(messageData, messageId);
      } catch (err) {
        log.error("failed to process Kafka message", {
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
          topic,
          partition,
        });
        runtime.error?.(`dingtalk-gateway Kafka message processing error: ${String(err)}`);
      }
    },
  });

  log.info(`DingTalk Gateway monitor started for userId=${userId}, consuming from ${inboundTopic}`);

  // Handle shutdown
  abortSignal?.addEventListener("abort", async () => {
    log.info("DingTalk Gateway monitor shutting down...");
    await kafkaClient.disconnect();
  });

  return {
    kafkaClient,
  };
}
