import { definePluginEntry, type OpenClawPluginApi, type PluginLogger } from "./api.js";
import { EmailSender } from "./src/email-sender.js";
import { FeedCollector } from "./src/feed-collector.js";
import { ReportGenerator } from "./src/generator.js";
import { MercurePusher, StreamingMercurePusher } from "./src/mercure-pusher.js";
import { TaskListener } from "./src/task-listener.js";
import { TaskPoller } from "./src/task-poller.js";
import { TemplateLoader } from "./src/template-loader.js";
import type { GeneratedReport } from "./src/types.js";
import type { ReportTask, ReportGeneratorConfig } from "./src/types.js";

function resolveConfig(pluginConfig: Record<string, unknown>): ReportGeneratorConfig {
  const historyDb = pluginConfig.historyDb as Record<string, unknown> | undefined;
  const mercure = pluginConfig.mercure as Record<string, unknown> | undefined;
  const smtp = pluginConfig.smtp as Record<string, unknown> | undefined;
  const rabbitmq = pluginConfig.rabbitmq as Record<string, unknown> | undefined;

  const rabbitmqHost = (rabbitmq?.host as string) ?? process.env.RABBITMQ_HOST ?? "";
  const rabbitmqUser = (rabbitmq?.user as string) ?? process.env.RABBITMQ_USER ?? "";

  return {
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
    smtp: smtp
      ? {
          host: (smtp.host as string) ?? "",
          port: Number(smtp.port ?? 587),
          user: (smtp.user as string) ?? "",
          password: (smtp.password as string) ?? "",
          from: (smtp.from as string) ?? "",
        }
      : undefined,
    // RabbitMQ listener is optional: enabled when connection details resolve
    // (plugin config or RABBITMQ_* env shared with the rabbitmq-consumer plugin).
    rabbitmq:
      rabbitmqHost && rabbitmqUser
        ? {
            host: rabbitmqHost,
            port: Number(rabbitmq?.port ?? process.env.RABBITMQ_PORT ?? 5672),
            user: rabbitmqUser,
            password: (rabbitmq?.password as string) ?? process.env.RABBITMQ_PASSWORD ?? "",
            queue:
              (rabbitmq?.queue as string) ?? process.env.RABBITMQ_REPORT_TASK_QUEUE ?? "ReportTask",
          }
        : undefined,
    pollIntervalMs: Number(pluginConfig.pollIntervalMs ?? 30000),
  };
}

function formatDateTimeStart(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
}

/**
 * Normalize task params dateScope into { start, end }.
 * Supports every format found in the download table:
 * - object: { start: "...", end: "..." }
 * - string "start,end"        (rabbitmq-consumer's DownloadManager)
 * - string "YYYY-MM-DD"       (legacy frontend, dateType=date/day)
 * - string "YYYY-MM"          (legacy frontend, dateType=month)
 * - string "YYYY"             (legacy frontend, dateType=year)
 */
function normalizeDateScope(raw: unknown): { start: string; end: string } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.includes(",")) {
      const [start = "", end = ""] = trimmed.split(",").map((part) => part.trim());
      return { start, end };
    }

    const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dayMatch) {
      const [, y, m, d] = dayMatch.map(Number);
      return {
        start: formatDateTimeStart(new Date(y, m - 1, d)),
        end: formatDateTimeStart(new Date(y, m - 1, d + 1)),
      };
    }

    const monthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
    if (monthMatch) {
      const [, y, m] = monthMatch.map(Number);
      return {
        start: formatDateTimeStart(new Date(y, m - 1, 1)),
        end: formatDateTimeStart(new Date(y, m, 1)),
      };
    }

    const yearMatch = /^(\d{4})$/.exec(trimmed);
    if (yearMatch) {
      const y = Number(yearMatch[1]);
      return {
        start: formatDateTimeStart(new Date(y, 0, 1)),
        end: formatDateTimeStart(new Date(y + 1, 0, 1)),
      };
    }

    return { start: "", end: "" };
  }
  if (raw && typeof raw === "object") {
    const scope = raw as { start?: unknown; end?: unknown };
    return {
      start: typeof scope.start === "string" ? scope.start : "",
      end: typeof scope.end === "string" ? scope.end : "",
    };
  }
  return { start: "", end: "" };
}

function safeParseParams(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

let taskPollerRef: TaskPoller | undefined;
let taskListenerRef: TaskListener | undefined;
let feedCollectorRef: FeedCollector | undefined;
let templateLoaderRef: TemplateLoader | undefined;
let emailSenderRef: EmailSender | undefined;

export default definePluginEntry({
  id: "report-generator",
  name: "Report Generator",
  description: "Generate舆情 reports from feed data and push via Mercure/SMTP.",
  register(api: OpenClawPluginApi) {
    api.registerService({
      id: "report-generator",

      async start(ctx) {
        const config = resolveConfig(api.pluginConfig as Record<string, unknown>);

        if (!config.historyDb.user || !config.historyDb.host) {
          ctx.logger.warn("[REPORT_GENERATOR] Missing historyDb config, service not started");
          return;
        }
        if (!config.mercure.hubUrl) {
          ctx.logger.warn("[REPORT_GENERATOR] Missing Mercure config, service not started");
          return;
        }

        const feedCollector = new FeedCollector(config.historyDb);
        const mercurePusher = new MercurePusher(config.mercure, ctx.logger);
        const templateLoader = new TemplateLoader(config.historyDb);
        const reportGenerator = new ReportGenerator(api.runtime);
        const taskPoller = new TaskPoller(config.historyDb, config.pollIntervalMs);

        feedCollectorRef = feedCollector;
        taskPollerRef = taskPoller;
        templateLoaderRef = templateLoader;

        // Create email sender if SMTP config is available
        if (config.smtp) {
          emailSenderRef = new EmailSender(config.smtp);
          ctx.logger.info("[REPORT_GENERATOR] Email sender initialized");
        } else {
          ctx.logger.info("[REPORT_GENERATOR] No SMTP config, email sending disabled");
        }

        const processTask = async (task: ReportTask, logger: PluginLogger): Promise<void> => {
          // Atomic claim (Pending → Running): the RabbitMQ listener and the
          // fallback poller may race for the same task; only one wins.
          const claimed = await taskPoller.claimTask(task.id);
          if (!claimed) {
            logger.info(`[REPORT_GENERATOR] Task #${task.id} already claimed, skipping`);
            return;
          }

          // Parse params (dateScope supports both "start,end" and {start,end})
          const params = safeParseParams(task.params);
          const dateScope = normalizeDateScope(params.dateScope);

          // Stream generation progress to the chat topic the request came from
          // (stored in params by the rabbitmq-consumer; falls back to the uid).
          const streamTopic =
            typeof params.mercureTopic === "string" && params.mercureTopic
              ? params.mercureTopic
              : String(task.uid);

          // Per-user agent for autonomous DB-querying generation (set by the
          // rabbitmq-consumer; legacy tasks fall back to prefed-data mode).
          const agentId =
            typeof params.agentId === "string" && params.agentId ? params.agentId : undefined;
          const streamPusher = new StreamingMercurePusher(mercurePusher, streamTopic, task.id);

          // First-byte ack: the user sees a reaction the moment the task is
          // claimed, before template loading / query planning emit their
          // first progress line. Fire-and-forget: never blocks generation.
          void mercurePusher.pushReportProgress(streamTopic, "已接到报告任务，正在准备数据…", task.id);

          try {
            if (!dateScope.start || !dateScope.end) {
              throw new Error(`Invalid dateScope in task params: ${task.params}`);
            }

            // Load template. An explicit templateId (the user picked one in the
            // frontend's template panel, stored by the rabbitmq-consumer) loads
            // that exact row; otherwise fall back to waterfall resolution
            // (topic-bound → user default → user any → system → code fallback).
            const explicitTemplateId =
              typeof params.templateId === "number"
                ? params.templateId
                : typeof params.templateId === "string"
                  ? parseInt(params.templateId, 10) || 0
                  : 0;
            const rawTemplate =
              explicitTemplateId > 0
                ? await templateLoader.loadTemplateById(
                    explicitTemplateId,
                    task.uid,
                    task.period,
                    logger,
                  )
                : await templateLoader.loadTemplate(task.period, task.uid, logger, task.topicId);

            // Generate report, streaming LLM deltas to the frontend in real
            // time. Data flows LLM-plan -> code-validated SQL -> digest:
            // collectStats runs the validated plan with full-set aggregation.
            const report: GeneratedReport = await reportGenerator.generate(
              {
                period: task.period,
                requirement: task.requirement,
                dateScope: `${dateScope.start} ~ ${dateScope.end}`,
                collectStats: (plan) =>
                  feedCollector.collectStats(
                    task.topicId,
                    task.slaveTopicId,
                    dateScope.start,
                    dateScope.end,
                    plan,
                    logger,
                  ),
                template: rawTemplate,
                userId: String(task.uid),
                topicId: task.topicId,
                slaveTopicId: task.slaveTopicId,
                agentId,
                onDelta: (delta) => streamPusher.appendDelta(delta),
                // Transient status lines for the tool phase (no text deltas
                // flow then). Fire-and-forget: never blocks generation.
                onActivity: (message) => {
                  void mercurePusher.pushReportProgress(streamTopic, message, task.id);
                },
                // Structured timeline steps for the report card's "工作过程"
                // panel. Fire-and-forget: never blocks generation.
                onStep: (step) => {
                  void mercurePusher.pushReportStep(streamTopic, step, task.id);
                },
              },
              logger,
            );

            // Update download record
            await taskPoller.updateTaskResult(task.id, report.title, report.content, "Done");

            // Flush any buffered stream text, then deliver the final report
            // event and unlock the frontend.
            await streamPusher.flush();
            await mercurePusher.push({
              topic: String(task.uid),
              title: report.title,
              content: report.content,
              userId: String(task.uid),
              taskId: task.id,
              // Chat-initiated tasks carry the frontend's subscription topic
              // in params.mercureTopic (= streamTopic); deliver the final
              // report there. Legacy tasks keep the user/<uid> fallback.
              targetTopic:
                typeof params.mercureTopic === "string" && params.mercureTopic
                  ? streamTopic
                  : undefined,
            });
            await mercurePusher.pushReportDone(streamTopic, task.id);

            // Send email if configured and user email is available
            if (emailSenderRef && task.userEmail) {
              try {
                const htmlContent = emailSenderRef.markdownToHtml(report.content, report.title);
                await emailSenderRef.sendEmail(
                  {
                    to: task.userEmail,
                    subject: report.title,
                    body: report.content,
                    bodyHtml: htmlContent,
                  },
                  logger,
                );
                logger.info(`[REPORT_GENERATOR] Email sent to ${task.userEmail}`);
              } catch (emailError) {
                logger.error(`[REPORT_GENERATOR] Email send failed: ${String(emailError)}`);
                // Don't fail the task if email fails - report was already generated
              }
            }

            logger.info(`[REPORT_GENERATOR] Task #${task.id} completed`);
          } catch (error) {
            logger.error(`[REPORT_GENERATOR] Task #${task.id} failed: ${String(error)}`);
            await taskPoller.updateTaskStatus(task.id, "Fail");
            // Tell the frontend the stream ended so it does not show a
            // dangling partial report.
            // pushError already emits a taskId-scoped report_error; the
            // report_done lets the card stop its spinner even if the error
            // event was missed (e.g. SSE reconnect).
            await streamPusher.pushError("报告生成失败，请稍后重试。");
            await mercurePusher.pushReportDone(streamTopic, task.id);
          }
        };

        // Instant path: process tasks the moment rabbitmq-consumer queues them.
        if (config.rabbitmq) {
          const taskListener = new TaskListener(config.rabbitmq, ctx.logger, async (taskId) => {
            const task = await taskPoller.fetchTaskById(taskId);
            if (!task) {
              ctx.logger.warn(`[REPORT_GENERATOR] Notified task #${taskId} not found`);
              return;
            }
            await processTask(task, ctx.logger);
          });
          taskListenerRef = taskListener;
          taskListener.start().catch((err: unknown) => {
            ctx.logger.error(`[REPORT_GENERATOR] Task listener fatal error: ${String(err)}`);
          });
        } else {
          ctx.logger.info(
            "[REPORT_GENERATOR] No RabbitMQ config, relying on polling only " +
              "(reports start with up to pollIntervalMs delay)",
          );
        }

        // Fallback path: pick up tasks whose notification was lost (or created
        // by other producers). claimTask() makes the two paths race-safe.
        taskPoller.start(ctx.logger, processTask);
      },

      async stop(ctx) {
        if (taskListenerRef) {
          await taskListenerRef.stop();
          taskListenerRef = undefined;
        }
        if (taskPollerRef) {
          await taskPollerRef.stop(ctx.logger);
          taskPollerRef = undefined;
        }
        if (feedCollectorRef) {
          await feedCollectorRef.close();
          feedCollectorRef = undefined;
        }
        if (templateLoaderRef) {
          await templateLoaderRef.close();
          templateLoaderRef = undefined;
        }
        emailSenderRef = undefined;
        ctx.logger.info("[REPORT_GENERATOR] Service stopped");
      },
    });
  },
});
