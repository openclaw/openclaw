import type { DingTalkGatewayConfig } from "openclaw/plugin-sdk";
import { createKafkaClient } from "./kafka.js";

export type ProbeDingTalkGatewayResult = {
  ok: boolean;
  error?: string;
  userId?: string;
};

export async function probeDingTalkGateway(
  cfg?: DingTalkGatewayConfig,
): Promise<ProbeDingTalkGatewayResult> {
  if (!cfg?.userId) {
    return {
      ok: false,
      error: "missing userId",
    };
  }

  const brokers = cfg.kafkaBrokers || "localhost:9092";
  const brokersArray = Array.isArray(brokers) ? brokers : brokers.split(",");

  // Built-in topic and group ID based on userId
  const kafkaGroupId = `dingtalk-user-${cfg.userId}-consumer`;
  const inboundTopic = `dingtalk-user-${cfg.userId}`;
  console.log("inboundTopic", inboundTopic);
  const outboundTopic = `dingtalk-reply-${cfg.userId}`;
  console.log("outboundTopic", outboundTopic);

  try {
    // Try to connect to Kafka to verify configuration
    const kafkaClient = createKafkaClient({
      brokers: brokersArray,
      groupId: kafkaGroupId,
      inboundTopic,
      outboundTopic,
    });

    await kafkaClient.connect();
    await kafkaClient.disconnect();

    return { ok: true, userId: cfg.userId };
  } catch (err) {
    return {
      ok: false,
      userId: cfg.userId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
