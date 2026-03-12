import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { A2AClient } from "./src/a2a-client.js";
import { resolveConfig } from "./src/config.js";
import { extractSummary, PendingTaskTracker } from "./src/pending-task-tracker.js";
import { registerTools } from "./src/register-tools.js";

const findooPlugin = {
  id: "findoo-alpha-plugin",
  name: "Findoo Alpha",
  description:
    "Bridge to LangGraph strategy-agent via A2A protocol — " +
    "37 professional financial analysis skills covering A-shares, US/HK equities, crypto, macro, and risk.",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const log = api.logger;

    // ── License Gate: no key → skip all registration ──
    if (!config.apiKey) {
      log.warn(
        "Findoo: license key not configured — plugin inactive. " +
          "Set FINDOO_API_KEY env var or configure in Control UI → Plugins → Findoo.",
      );
      return;
    }

    log.info(`findoo-alpha: connecting to ${config.strategyAgentUrl}`);
    log.info(`findoo-alpha: assistant ${config.strategyAssistantId}`);

    // Shared A2AClient instance (used by both tools and tracker)
    const a2a = new A2AClient(config.strategyAgentUrl, config.strategyAssistantId);

    // Verify connectivity at startup (non-blocking)
    fetch(`${config.strategyAgentUrl}/ok`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => {
        if (r.ok) {
          log.info("findoo-alpha: strategy-agent is reachable ✓");
        } else {
          log.warn(`findoo-alpha: strategy-agent returned ${r.status}`);
        }
      })
      .catch((err) => {
        log.warn(
          `findoo-alpha: strategy-agent unreachable (${err instanceof Error ? err.message : err}). Tools will retry on use.`,
        );
      });

    // ── enqueueSystemEvent bridge (heartbeat push) ──
    type RuntimeServices = {
      system?: {
        enqueueSystemEvent?: (
          text: string,
          options: { sessionKey: string; contextKey?: string },
        ) => void;
      };
    };

    const runtime = api.runtime as unknown as RuntimeServices | undefined;
    const enqueueSystemEvent = runtime?.system?.enqueueSystemEvent;

    // ── PendingTaskTracker (background stream consumer) ──
    let tracker: PendingTaskTracker | undefined;

    if (enqueueSystemEvent) {
      tracker = new PendingTaskTracker({
        a2aClient: a2a,
        timeoutMs: config.taskTimeoutMs,
        log: (level, msg) => {
          if (level === "warn" || level === "error") log.warn(msg);
          else log.info(msg);
        },

        onTaskCompleted(task, result) {
          const summary = extractSummary(result);
          enqueueSystemEvent(`[findoo] 深度分析完成 — "${task.query.slice(0, 40)}"\n\n${summary}`, {
            sessionKey: "main",
            contextKey: "findoo-analysis",
          });
        },

        onTaskFailed(task, error) {
          enqueueSystemEvent(`[findoo] 分析任务失败 — "${task.query.slice(0, 40)}": ${error}`, {
            sessionKey: "main",
            contextKey: "findoo-analysis",
          });
        },
      });

      log.info(
        `findoo-alpha: task tracker ready (timeout=${config.taskTimeoutMs}ms, stream-based)`,
      );
    } else {
      log.info(
        "findoo-alpha: enqueueSystemEvent not available, tracker disabled (async results won't be pushed)",
      );
    }

    // Register A2A-bridged tools
    registerTools(api, config, a2a, tracker);

    // Expose service for cross-plugin consumption
    api.runtime?.services?.set("fin-strategy-agent", {
      id: "fin-strategy-agent",
      getConfig: () => ({
        url: config.strategyAgentUrl,
        assistantId: config.strategyAssistantId,
      }),
    });
  },
};

export default findooPlugin;
