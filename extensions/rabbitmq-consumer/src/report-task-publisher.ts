import amqplib from "amqplib";
import type { PluginLogger } from "../api.js";

interface PublisherConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  queue: string;
}

/**
 * Lightweight RabbitMQ publisher that notifies the report-generator plugin
 * the moment a report task row is inserted into the `download` table,
 * eliminating the poll latency on the consumer side.
 *
 * Publish failures are non-fatal: the report-generator keeps a fallback
 * poller that picks up any Pending task the notification missed.
 */
export class ReportTaskPublisher {
  private readonly config: PublisherConfig;
  private readonly logger: PluginLogger;

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

  constructor(config: PublisherConfig, logger: PluginLogger) {
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
      this.logger.warn(`[REPORT_TASK_PUBLISHER] Connection error: ${err.message}`);
    });
    connection.on("close", () => {
      this.connection = null;
      this.channel = null;
    });

    const channel = await connection.createChannel();
    channel.on("error", (err: Error) => {
      this.logger.warn(`[REPORT_TASK_PUBLISHER] Channel error: ${err.message}`);
    });
    channel.on("close", () => {
      this.channel = null;
    });
    await channel.assertQueue(this.config.queue, { durable: true });

    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  /**
   * Publish a task-created notification. Returns false on failure so the
   * caller can rely on the report-generator poller as fallback.
   */
  async publishTaskCreated(taskId: number): Promise<boolean> {
    try {
      const channel = await this.getChannel();
      channel.sendToQueue(this.config.queue, Buffer.from(JSON.stringify({ taskId })), {
        persistent: true,
        contentType: "application/json",
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `[REPORT_TASK_PUBLISHER] Publish failed for task #${taskId} ` +
          `(poller fallback will pick it up): ${String(error)}`,
      );
      // Drop the broken connection so the next publish reconnects cleanly.
      this.channel = null;
      this.connection = null;
      return false;
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
