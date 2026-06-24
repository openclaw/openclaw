import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { processChatMessage, warmupAgent } from "./src/chat-pipeline.js";
import { DownloadManager } from "./src/download-manager.js";
import { FeedCounter } from "./src/feed-counter.js";
import { HistoryManager } from "./src/history-manager.js";
import { parseMessage, parseWarmup } from "./src/message-handler.js";
import { RabbitMqClient } from "./src/rabbitmq-client.js";
import { ReportTaskPublisher } from "./src/report-task-publisher.js";
import { ReportTemplateLookup } from "./src/report-template-lookup.js";
import { TopicResolver } from "./src/topic-resolver.js";
import type { RabbitMqPluginConfig, WriterDbConfig } from "./src/types.js";

/**
 * Resolve plugin config from the plugin config object, with env var fallbacks.
 */
function resolvePluginConfig(pluginConfig: Record<string, unknown>): RabbitMqPluginConfig {
  const rabbitmq = pluginConfig.rabbitmq as Record<string, unknown> | undefined;
  const historyDb = pluginConfig.historyDb as Record<string, unknown> | undefined;
  const mercure = pluginConfig.mercure as Record<string, unknown> | undefined;

  return {
    rabbitmq: {
      host: (rabbitmq?.host as string) ?? process.env.RABBITMQ_HOST ?? "127.0.0.1",
      port: Number(rabbitmq?.port ?? process.env.RABBITMQ_PORT ?? 5672),
      user: (rabbitmq?.user as string) ?? process.env.RABBITMQ_USER ?? "",
      password: (rabbitmq?.password as string) ?? process.env.RABBITMQ_PASSWORD ?? "",
      queue: (rabbitmq?.queue as string) ?? process.env.RABBITMQ_QUEUE ?? "MessageProxy",
      reportTaskQueue:
        (rabbitmq?.reportTaskQueue as string) ??
        process.env.RABBITMQ_REPORT_TASK_QUEUE ??
        "ReportTask",
    },
    historyDb: {
      host: (historyDb?.host as string) ?? process.env.HISTORY_MYSQL_HOST ?? "127.0.0.1",
      port: Number(historyDb?.port ?? process.env.HISTORY_MYSQL_PORT ?? 3306),
      user: (historyDb?.user as string) ?? process.env.HISTORY_MYSQL_USER ?? "",
      password: (historyDb?.password as string) ?? process.env.HISTORY_MYSQL_PASSWORD ?? "",
      database:
        (historyDb?.database as string) ?? process.env.HISTORY_MYSQL_DATABASE ?? "superworker",
    },
    mercure: {
      hubUrl: (mercure?.hubUrl as string) ?? process.env.MERCURE_HUB_URL ?? "",
      jwtSecret: (mercure?.jwtSecret as string) ?? process.env.MERCURE_JWT_SECRET ?? "",
    },
  };
}

/**
 * Resolve writer DB config from the plugin config object, with env var fallbacks.
 * Returns undefined when no dedicated writer is configured (falls back to reader).
 */
function resolveWriterConfig(pluginConfig: Record<string, unknown>): WriterDbConfig | undefined {
  const writerDb = pluginConfig.writerDb as Record<string, unknown> | undefined;
  const envUser = process.env.WRITER_MYSQL_USER;
  const envPassword = process.env.WRITER_MYSQL_PASSWORD;
  if (!writerDb && !envUser && !envPassword) {
    return undefined;
  }
  return {
    host:
      (writerDb?.host as string) ??
      process.env.WRITER_MYSQL_HOST ??
      process.env.HISTORY_MYSQL_HOST ??
      "127.0.0.1",
    port: Number(
      writerDb?.port ?? process.env.WRITER_MYSQL_PORT ?? process.env.HISTORY_MYSQL_PORT ?? 3306,
    ),
    user: (writerDb?.user as string) ?? envUser ?? "",
    password: (writerDb?.password as string) ?? envPassword ?? "",
    database:
      (writerDb?.database as string) ??
      process.env.WRITER_MYSQL_DATABASE ??
      process.env.HISTORY_MYSQL_DATABASE ??
      "superworker",
  };
}

/** Module-level references for service lifecycle management (avoids mutating the api object). */
let clientRef: RabbitMqClient | undefined;
let historyRef: HistoryManager | undefined;
let downloadRef: DownloadManager | undefined;
let topicResolverRef: TopicResolver | undefined;
let feedCounterRef: FeedCounter | undefined;
let reportPublisherRef: ReportTaskPublisher | undefined;
let templateLookupRef: ReportTemplateLookup | undefined;

export default definePluginEntry({
  id: "rabbitmq-consumer",
  name: "RabbitMQ Consumer",
  description: "Consume chat messages from RabbitMQ and process them via OpenClaw subagent.",
  register(api: OpenClawPluginApi) {
    api.registerService({
      id: "rabbitmq-consumer",

      async start(ctx) {
        const pluginConfig = resolvePluginConfig(api.pluginConfig as Record<string, unknown>);

        if (!pluginConfig.rabbitmq.user || !pluginConfig.rabbitmq.host) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing RabbitMQ config, service not started");
          return;
        }
        if (!pluginConfig.historyDb.user || !pluginConfig.historyDb.host) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing historyDb config, service not started");
          return;
        }
        if (!pluginConfig.mercure.hubUrl) {
          ctx.logger.warn("[RABBITMQ_CONSUMER] Missing Mercure config, service not started");
          return;
        }

        // Shared HistoryManager across messages (pool reuse)
        const writerConfig = resolveWriterConfig(api.pluginConfig as Record<string, unknown>);
        historyRef = new HistoryManager(pluginConfig.historyDb, writerConfig);
        downloadRef = new DownloadManager(pluginConfig.historyDb, writerConfig);
        topicResolverRef = new TopicResolver(pluginConfig.historyDb);
        feedCounterRef = new FeedCounter(pluginConfig.historyDb);
        templateLookupRef = new ReportTemplateLookup(pluginConfig.historyDb);
        reportPublisherRef = new ReportTaskPublisher(
          {
            host: pluginConfig.rabbitmq.host,
            port: pluginConfig.rabbitmq.port,
            user: pluginConfig.rabbitmq.user,
            password: pluginConfig.rabbitmq.password,
            queue: pluginConfig.rabbitmq.reportTaskQueue,
          },
          ctx.logger,
        );

        const client = new RabbitMqClient(pluginConfig.rabbitmq, ctx.logger, async (msg) => {
          // Warmup envelopes carry no history id and must be handled before
          // parseMessage (which would reject them). Best-effort, fire silently.
          const warmup = parseWarmup(msg.content);
          if (warmup) {
            ctx.logger.info(`[RABBITMQ_CONSUMER] Warmup request: userId=${warmup.userId}`);
            await warmupAgent(warmup.userId, api.runtime, ctx.logger);
            return;
          }

          const chatMsg = parseMessage(msg.content);
          if (!chatMsg) {
            ctx.logger.error("[RABBITMQ_CONSUMER] Failed to parse message");
            return;
          }

          ctx.logger.info(
            `[RABBITMQ_CONSUMER] Received message: historyId=${chatMsg.historyId}, ` +
              `userId=${chatMsg.userId}`,
          );

          await processChatMessage(
            chatMsg,
            historyRef!,
            pluginConfig.mercure,
            api.runtime,
            ctx.logger,
            downloadRef,
            topicResolverRef,
            feedCounterRef,
            reportPublisherRef,
            templateLookupRef,
          );
        });

        clientRef = client;

        client.start().catch((err) => {
          ctx.logger.error(`[RABBITMQ_CONSUMER] Fatal error: ${err}`);
        });
      },

      async stop(ctx) {
        if (clientRef) {
          await clientRef.stop();
          clientRef = undefined;
        }
        if (historyRef) {
          await historyRef.close();
          historyRef = undefined;
        }
        if (downloadRef) {
          await downloadRef.close();
          downloadRef = undefined;
        }
        if (topicResolverRef) {
          await topicResolverRef.close();
          topicResolverRef = undefined;
        }
        if (feedCounterRef) {
          await feedCounterRef.close();
          feedCounterRef = undefined;
        }
        if (reportPublisherRef) {
          await reportPublisherRef.close();
          reportPublisherRef = undefined;
        }
        if (templateLookupRef) {
          await templateLookupRef.close();
          templateLookupRef = undefined;
        }
        ctx.logger.info("[RABBITMQ_CONSUMER] Service stopped");
      },
    });
  },
});
