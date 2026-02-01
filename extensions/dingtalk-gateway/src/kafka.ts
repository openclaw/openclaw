import { Kafka, type Consumer, type Producer } from "kafkajs";
import type { Log } from "openclaw/plugin-sdk";

export interface KafkaConfig {
  brokers: string | string[];
  groupId?: string;
  inboundTopic?: string;
  outboundTopic?: string;
  log?: Log;
}

export interface KafkaClient {
  consumer: Consumer;
  producer: Producer;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function createKafkaClient(config: KafkaConfig): KafkaClient {
  console.log("createKafkaClient", config);
  const brokers = Array.isArray(config.brokers) ? config.brokers : config.brokers.split(",");
  const kafka = new Kafka({
    clientId: "openclaw-dingtalk-gateway",
    brokers,
    logLevel: config.log ? 4 : 0, // 4 = INFO, 0 = NOTHING
  });

  const consumer = kafka.consumer({
    groupId: config.groupId || "openclaw-dingtalk-gateway",
  });

  const producer = kafka.producer({
    allowAutoTopicCreation: true,
  });

  return {
    consumer,
    producer,
    async connect() {
      await consumer.connect();
      await producer.connect();
      config.log?.debug("Kafka client connected", { brokers });
    },
    async disconnect() {
      await consumer.disconnect();
      await producer.disconnect();
      config.log?.debug("Kafka client disconnected");
    },
  };
}
