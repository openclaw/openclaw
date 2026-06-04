import amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import type { RabbitMqConfig } from "./types.js";

type MessageHandler = (msg: amqplib.ConsumeMessage) => Promise<void>;

/**
 * RabbitMQ client with automatic reconnection and exponential backoff.
 *
 * Ported from Python rabbitmq_consumer.py RabbitMQConsumer.
 * Uses amqplib (async/await) instead of pika (sync).
 */
export class RabbitMqClient {
  private readonly config: RabbitMqConfig;
  private readonly logger: PluginLogger;
  private readonly handler: MessageHandler;

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private consuming = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RabbitMqConfig, logger: PluginLogger, handler: MessageHandler) {
    this.config = config;
    this.logger = logger;
    this.handler = handler;
  }

  /** Start consuming messages. Runs until stop() is called. */
  async start(): Promise<void> {
    this.consuming = true;
    await this.consumeLoop();
  }

  /** Stop consuming and disconnect. */
  async stop(): Promise<void> {
    this.consuming = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.cleanupConnection();
  }

  private async consumeLoop(): Promise<void> {
    let retryDelay = 5_000; // 5 seconds initial
    const maxRetryDelay = 300_000; // 5 minutes max

    while (this.consuming) {
      try {
        await this.connect();
        retryDelay = 5_000; // reset on success

        // The consumer is event-driven via amqplib; start() resolves when
        // the channel closes or an error occurs.
        // We set up a "close" listener to trigger reconnection.
        if (this.channel) {
          await new Promise<void>((resolve) => {
            const ch = this.channel;
            if (!ch) {
              resolve();
              return;
            }

            ch.on("close", () => {
              this.logger.info("[RABBITMQ] Channel closed");
              resolve();
            });

            ch.on("error", (err: Error) => {
              this.logger.error(`[RABBITMQ] Channel error: ${err.message}`);
              resolve();
            });
          });
        }
      } catch (error) {
        this.logger.error(`[RABBITMQ] Connection error: ${String(error)}`);
      }

      await this.cleanupConnection();

      if (!this.consuming) {
        break;
      }

      // Exponential backoff (interruptible via stop())
      this.logger.info(`[RABBITMQ] Reconnecting in ${retryDelay / 1000}s...`);
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(resolve, retryDelay);
      });
      this.reconnectTimer = null;

      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    this.logger.info("[RABBITMQ] Consumer stopped permanently");
  }

  private async connect(): Promise<void> {
    this.connection = await amqplib.connect({
      hostname: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.password,
      heartbeat: 60,
    });

    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.config.queue, { durable: true });
    await this.channel.prefetch(1);

    this.logger.info(`[RABBITMQ] Started consuming from queue: ${this.config.queue}`);

    await this.channel.consume(this.config.queue, async (msg) => {
      if (!msg) {
        return;
      }

      try {
        await this.handler(msg);
        this.channel?.ack(msg);
      } catch (error) {
        this.logger.error(`[RABBITMQ] Message handler error: ${String(error)}`);
        this.channel?.nack(msg, false, false);
      }
    });
  }

  private async cleanupConnection(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    try {
      if (this.connection) {
        await this.connection.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    this.channel = null;
    this.connection = null;
  }
}
