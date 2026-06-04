import amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import type { RabbitMqListenerConfig } from "./types.js";

type TaskNotificationHandler = (taskId: number) => Promise<void>;

/**
 * RabbitMQ listener that receives "report task created" notifications from
 * the rabbitmq-consumer plugin and triggers immediate processing, removing
 * the poll latency. Reconnection logic mirrors the rabbitmq-consumer's
 * RabbitMqClient (exponential backoff, interruptible via stop()).
 */
export class TaskListener {
  private readonly config: RabbitMqListenerConfig;
  private readonly logger: PluginLogger;
  private readonly handler: TaskNotificationHandler;

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private consuming = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: RabbitMqListenerConfig,
    logger: PluginLogger,
    handler: TaskNotificationHandler,
  ) {
    this.config = config;
    this.logger = logger;
    this.handler = handler;
  }

  /** Start consuming notifications. Runs until stop() is called. */
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

        // Wait until the channel closes or errors, then reconnect.
        if (this.channel) {
          await new Promise<void>((resolve) => {
            const ch = this.channel;
            if (!ch) {
              resolve();
              return;
            }

            ch.on("close", () => {
              this.logger.info("[TASK_LISTENER] Channel closed");
              resolve();
            });

            ch.on("error", (err: Error) => {
              this.logger.error(`[TASK_LISTENER] Channel error: ${err.message}`);
              resolve();
            });
          });
        }
      } catch (error) {
        this.logger.error(`[TASK_LISTENER] Connection error: ${String(error)}`);
      }

      await this.cleanupConnection();

      if (!this.consuming) {
        break;
      }

      this.logger.info(`[TASK_LISTENER] Reconnecting in ${retryDelay / 1000}s...`);
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(resolve, retryDelay);
      });
      this.reconnectTimer = null;

      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    this.logger.info("[TASK_LISTENER] Listener stopped permanently");
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

    this.logger.info(`[TASK_LISTENER] Listening for report tasks on queue: ${this.config.queue}`);

    await this.channel.consume(this.config.queue, async (msg) => {
      if (!msg) {
        return;
      }

      try {
        const taskId = this.parseTaskId(msg.content);
        if (taskId === null) {
          this.logger.warn(
            `[TASK_LISTENER] Ignoring malformed notification: ${msg.content.toString("utf-8").slice(0, 200)}`,
          );
        } else {
          await this.handler(taskId);
        }
        this.channel?.ack(msg);
      } catch (error) {
        this.logger.error(`[TASK_LISTENER] Notification handler error: ${String(error)}`);
        // Drop the message: the fallback poller retries Pending tasks anyway,
        // so requeueing would only risk a poison-message loop.
        this.channel?.nack(msg, false, false);
      }
    });
  }

  private parseTaskId(content: Buffer): number | null {
    try {
      const parsed = JSON.parse(content.toString("utf-8")) as { taskId?: unknown };
      const taskId = Number(parsed?.taskId);
      return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
    } catch {
      return null;
    }
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
