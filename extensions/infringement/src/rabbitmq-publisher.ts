import amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import type { RabbitMqConfig } from "./types.js";

/**
 * Publishes caseIds to the Java 研判 worker queue (Queue::TaskWorker).
 *
 * Wire contract mirrors leading-v2.0 RabbitMQUtils::publishSingleTask:
 *   - publish to the default exchange ("") with routing key = queue name
 *     (amqplib sendToQueue does exactly this),
 *   - body is the bare caseId string (PHP casts the int to string),
 *   - delivery mode persistent, queue declared durable.
 *
 * The Java side consumes the caseId, reads the DB rows, runs the 研判, and
 * writes results back — identical to a dispatch from the PHP frontend.
 */
export class TaskWorkerPublisher {
  private readonly config: RabbitMqConfig;
  private readonly logger: PluginLogger;

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  constructor(config: RabbitMqConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  private async getChannel(): Promise<amqplib.Channel> {
    if (this.channel) {
      return this.channel;
    }

    const connection = await amqplib.connect({
      hostname: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.password,
      heartbeat: 60,
    });
    connection.on("error", (err: Error) => {
      this.logger.warn(`[INFRINGEMENT_PUBLISHER] Connection error: ${err.message}`);
    });
    connection.on("close", () => {
      this.connection = null;
      this.channel = null;
    });

    const channel = await connection.createChannel();
    channel.on("error", (err: Error) => {
      this.logger.warn(`[INFRINGEMENT_PUBLISHER] Channel error: ${err.message}`);
    });
    channel.on("close", () => {
      this.channel = null;
    });
    // durable:true matches RabbitMQUtils::createChannel queue_declare.
    await channel.assertQueue(this.config.taskQueue, { durable: true });

    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  /**
   * Dispatch a caseId to the 研判 worker. Throws on failure so the caller can
   * surface the error to the LLM (unlike the report publisher, there is no
   * poller fallback here — a dropped dispatch means the case never analyzes).
   */
  async dispatchCase(caseId: number): Promise<void> {
    try {
      const channel = await this.getChannel();
      channel.sendToQueue(this.config.taskQueue, Buffer.from(String(caseId)), {
        persistent: true,
      });
    } catch (error) {
      // Drop the broken connection so the next dispatch reconnects cleanly.
      this.channel = null;
      this.connection = null;
      throw new Error(
        `Failed to dispatch case #${caseId} to ${this.config.taskQueue}: ${String(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  async close(): Promise<void> {
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
