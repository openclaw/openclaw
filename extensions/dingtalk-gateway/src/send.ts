import type { RobotTextMessage } from "dingtalk-stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getDingTalkGatewayRuntime } from "./runtime.js";
import type { KafkaClient } from "./kafka.js";

export type SendDingTalkGatewayMessageParams = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  /** Optional sessionWebhook (from incoming message) */
  sessionWebhook?: string;
  kafkaClient: KafkaClient;
  outboundTopic: string;
};

export type SendDingTalkGatewayMessageResult = {
  messageId: string;
  conversationId: string;
};

/**
 * Send a message via DingTalk Gateway (Kafka).
 * The message format matches dingtalk-stream's RobotTextMessage format.
 */
export async function sendMessageDingTalkGateway(
  params: SendDingTalkGatewayMessageParams,
): Promise<SendDingTalkGatewayMessageResult> {
  const { cfg, to, text, mediaUrl, sessionWebhook, kafkaClient, outboundTopic } = params;
  const core = getDingTalkGatewayRuntime();
  const log = core.logging.getChildLogger({ name: "dingtalk-gateway" });

  if (!text.trim() && !mediaUrl) {
    throw new Error("Message text or mediaUrl is required");
  }

  // Construct reply message in RobotTextMessage format
  const replyMessage: Partial<RobotTextMessage> = {
    conversationId: to,
    conversationType: "1", // Assume DM for now; could be "2" for group
    text: {
      content: text,
    },
    sessionWebhook, // Include sessionWebhook if available
    createAt: Date.now(),
  };

  try {
    // Send to Kafka outbound topic
    await kafkaClient.producer.send({
      topic: outboundTopic,
      messages: [
        {
          key: to, // Use conversationId as key for partitioning
          value: JSON.stringify(replyMessage),
          headers: {
            messageType: "reply",
            conversationId: to,
            ...(sessionWebhook ? { sessionWebhook } : {}),
          },
        },
      ],
    });

    const messageId = `dtgw-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    log.debug("sent message via Kafka", { to, messageId, outboundTopic });
    return { messageId, conversationId: to };
  } catch (err) {
    log.error("failed to send message via Kafka", {
      error: String(err),
      to,
      outboundTopic,
    });
    throw new Error(`Failed to send DingTalk Gateway message: ${String(err)}`);
  }
}
