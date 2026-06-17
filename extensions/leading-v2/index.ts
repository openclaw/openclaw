import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  createJobListToolFactory,
  createJobStopToolFactory,
  createLetterFetchToolFactory,
  createLetterGenerateToolFactory,
} from "./src/ai/ai-tools.js";
import { closePool } from "./src/client/db-client.js";
import { resolveConfig } from "./src/client/http-client.js";
import { ApiKeyResolver } from "./src/client/key-resolver.js";
import { RecentTaskStore } from "./src/client/recent-tasks.js";
import {
  createCrawlRefreshCreateToolFactory,
  createCrawlRefreshListToolFactory,
  createCrawlRefreshStatusToolFactory,
  type RecentCrawlRefresh,
} from "./src/crawl/crawl-tools.js";
import { resolveNotifyConfig } from "./src/notify/config.js";
import { pollCrawlRefresh } from "./src/notify/crawl-adapter.js";
import { debugLog } from "./src/notify/debug.js";
import { MercurePusher, resolveMercureConfig } from "./src/notify/mercure.js";
import { resolveSmtpConfig } from "./src/notify/email-client.js";
import { Notifier, type NotificationTransport } from "./src/notify/notification.js";
import { DbHistoryTransport } from "./src/notify/transports/db-history.js";
import { EmailNotificationTransport } from "./src/notify/transports/email.js";
import { MercureNotificationTransport } from "./src/notify/transports/mercure-notification.js";
import { CompletionNotifier } from "./src/notify/notifier.js";
import { getSharedPendingRegistry } from "./src/notify/pending-store.js";
import {
  createLinkBatchCreateToolFactory,
  createLinkBatchStatusToolFactory,
  type RecentLinkBatch,
} from "./src/link/link-tools.js";
import {
  createFeedListToolFactory,
  createFeedReanalyzeToolFactory,
  createMonthlyStatsToolFactory,
  createTopicListToolFactory,
} from "./src/opinion/opinion-read-tools.js";
import {
  createOpinionAnalyzeToolFactory,
  createOpinionDownloadListToolFactory,
  createOpinionDownloadStatusToolFactory,
  createOpinionExportToolFactory,
  createSheetReportToolFactory,
  type RecentDownload,
} from "./src/opinion/opinion-task-tools.js";
import {
  createOpinionContentToolFactory,
  createReportCreateToolFactory,
  createReportStatusToolFactory,
  createReportStopToolFactory,
  type RecentReport,
} from "./src/report/report-tools.js";

export default definePluginEntry({
  id: "leading-v2",
  name: "Leading V2 Backend",
  description:
    "Submit tasks and poll their status across leading-v2.0 backend modules by calling the PHP HTTP API " +
    "as the chat user (Authorization: Bearer <per-uid apiKey>). Tools are scoped to rabbitmq-<userId> " +
    "agents; per-uid keys are resolved (and auto-provisioned) from the api_key table.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});
    // One shared resolver for the whole backend: each uid is minted/cached once.
    const resolver = new ApiKeyResolver(config.apiKeys, config.db);

    // --- link-data-crawler (失效链接强化检测，task_type=link_check) ---
    const linkBatches = new RecentTaskStore<RecentLinkBatch>();
    api.registerTool(createLinkBatchCreateToolFactory(api, resolver, linkBatches), {
      name: "link_batch_create",
    });
    api.registerTool(createLinkBatchStatusToolFactory(api, resolver, linkBatches), {
      name: "link_batch_status",
    });

    // --- industry-report (行业/舆情报告 + 评论/回应生成) ---
    const reports = new RecentTaskStore<RecentReport>();
    api.registerTool(createReportCreateToolFactory(api, resolver, reports), {
      name: "report_create",
    });
    api.registerTool(createOpinionContentToolFactory(api, resolver, reports), {
      name: "opinion_content_create",
    });
    api.registerTool(createReportStatusToolFactory(api, resolver, reports), {
      name: "report_status",
    });
    api.registerTool(createReportStopToolFactory(api, resolver, reports), {
      name: "report_stop",
    });

    // --- pub-opinion (舆情监测/研判) ---
    const downloads = new RecentTaskStore<RecentDownload>();
    api.registerTool(createOpinionAnalyzeToolFactory(api, resolver, downloads), {
      name: "opinion_analyze",
    });
    api.registerTool(createOpinionExportToolFactory(api, resolver, downloads), {
      name: "opinion_report_export",
    });
    api.registerTool(createSheetReportToolFactory(api, resolver, downloads), {
      name: "sheet_report_create",
    });
    api.registerTool(createOpinionDownloadStatusToolFactory(api, resolver, downloads), {
      name: "opinion_download_status",
    });
    api.registerTool(createOpinionDownloadListToolFactory(api, resolver), {
      name: "opinion_download_list",
    });
    api.registerTool(createFeedListToolFactory(api, resolver), { name: "feed_list" });
    api.registerTool(createTopicListToolFactory(api, resolver), { name: "topic_list" });
    api.registerTool(createFeedReanalyzeToolFactory(api, resolver), { name: "feed_reanalyze" });
    api.registerTool(createMonthlyStatsToolFactory(api, resolver), { name: "monthly_stats" });

    // --- ai (任务管理 + 维权文书) ---
    api.registerTool(createJobListToolFactory(api, resolver), { name: "job_list" });
    api.registerTool(createJobStopToolFactory(api, resolver), { name: "job_stop" });
    api.registerTool(createLetterGenerateToolFactory(api, resolver), { name: "letter_generate" });
    api.registerTool(createLetterFetchToolFactory(api, resolver), { name: "letter_fetch" });

    // --- link-data-crawler (互动量刷新，只读：重抓互动量但不写回主看板) ---
    const notify = resolveNotifyConfig(api.pluginConfig ?? {});
    // Process-global singleton: the tool-discovery register() and the service
    // register() must enqueue into and poll the SAME registry instance.
    const pendingTasks = getSharedPendingRegistry();
    const crawlRefreshes = new RecentTaskStore<RecentCrawlRefresh>();
    api.registerTool(
      createCrawlRefreshCreateToolFactory(api, resolver, crawlRefreshes, pendingTasks, notify),
      { name: "crawl_refresh_create" },
    );
    api.registerTool(createCrawlRefreshStatusToolFactory(api, resolver, crawlRefreshes), {
      name: "crawl_refresh_status",
    });
    api.registerTool(createCrawlRefreshListToolFactory(api, resolver), {
      name: "crawl_refresh_list",
    });

    let notifier: CompletionNotifier | undefined;
    api.registerService({
      id: "leading-v2",
      async start(ctx) {
        try {
          const stateFile = join(ctx.stateDir, "leading-v2-notify.json");
          await pendingTasks.init(stateFile, ctx.logger);
          debugLog(
            `service.start enabled=${notify.enabled} pollMs=${notify.pollIntervalMs} ` +
              `loaded=${pendingTasks.all().length} hasRuntime=${Boolean(api.runtime)} ` +
              `hasSubagent=${Boolean(api.runtime?.subagent)} stateFile=${stateFile}`,
          );
          if (notify.enabled) {
            // Generic Notifier: tasks emit a Notification; transports deliver it.
            // T1 = Mercure `notification` event on the user's topic (web frontend
            // renders it via one handler — see plan-notifier-delivery.md §3.1).
            const mercureCfg = resolveMercureConfig(api.pluginConfig ?? {});
            const transports: NotificationTransport[] = [];
            if (mercureCfg) {
              // T1 live in-app event (renders if the user's chat SSE is open).
              transports.push(new MercureNotificationTransport(new MercurePusher(mercureCfg, ctx.logger)));
            }
            if (config.db) {
              // T2 durable: persist as an assistant-only history row so it shows
              // on next reload even if the user was offline (key for scheduled tasks).
              transports.push(new DbHistoryTransport(config.db));
            }
            const smtpCfg = resolveSmtpConfig(api.pluginConfig ?? {});
            if (smtpCfg && config.db) {
              // T3 offline push: email subscribers (address from feed_report_subscriber).
              transports.push(new EmailNotificationTransport(smtpCfg, config.db));
            }
            const fanout = new Notifier(transports, ctx.logger);
            if (!fanout.hasTransports()) {
              ctx.logger.warn("[LEADING_V2] No notification transport configured (set plugins.leading-v2.mercure)");
            }
            const deliver = async (
              task: { uid: string; sessionKey: string; mercureTopic: string; backendId: string; title: string | null },
              summary: string,
            ) => {
              const topic = task.mercureTopic || task.uid;
              debugLog(`deliver notification topic=${topic} category=crawl_refresh`);
              await fanout.notify(
                {
                  id: `crawl_refresh:${task.backendId}`,
                  uid: task.uid,
                  category: "crawl_refresh",
                  level: "success",
                  title: task.title ? `互动量刷新：${task.title}` : "互动量刷新完成",
                  body: summary,
                  ts: Date.now(),
                },
                { mercureTopic: topic, sessionKey: task.sessionKey },
              );
            };
            notifier = new CompletionNotifier({
              registry: pendingTasks,
              resolver,
              config,
              notify,
              deliver,
              logger: ctx.logger,
              adapters: { crawl_refresh: pollCrawlRefresh },
            });
            notifier.start();
          }
          ctx.logger.info("[LEADING_V2] Service initialized");
        } catch (error) {
          debugLog(`service.start ERROR ${String(error)}`);
          throw error;
        }
      },
      async stop(ctx) {
        notifier?.stop();
        await pendingTasks.flush();
        await closePool();
        ctx.logger.info("[LEADING_V2] DB pool closed, service stopped");
      },
    });
  },
});
