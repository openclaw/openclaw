import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveConfig } from "./src/config.js";
import { ExpertManager } from "./src/expert-manager.js";
import { LangGraphClient } from "./src/langgraph-client.js";
import { registerTools } from "./src/register-tools.js";
import { TaskStore } from "./src/task-store.js";

const findooPlugin = {
  id: "findoo-alpha-plugin",
  name: "Findoo Alpha",
  description:
    "Bridge to LangGraph strategy-agent — " +
    "37 professional financial analysis skills covering A-shares, US/HK equities, crypto, macro, and risk.",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const log = api.logger;

    // License gate
    if (!config.apiKey) {
      log.warn(
        "Findoo: license key not configured — plugin inactive. " +
          "Set FINDOO_API_KEY env var or configure in Control UI → Plugins → Findoo.",
      );
      return;
    }

    log.info(`findoo-alpha: connecting to ${config.strategyAgentUrl}`);
    log.info(`findoo-alpha: assistant ${config.strategyAssistantId}`);
    log.info(`findoo-alpha: async mode (LangGraph native + ACP relay)`);

    const client = new LangGraphClient(config.strategyAgentUrl, config.strategyAssistantId);
    const taskStore = new TaskStore(api.resolvePath("state/findoo-alpha-tasks.sqlite"));

    // Resolve SystemEvent + HeartbeatWake APIs
    const enqueueSystemEvent = (api.runtime as Record<string, unknown>)?.system
      ? ((api.runtime as Record<string, Record<string, unknown>>).system.enqueueSystemEvent as
          | ((text: string, options: { sessionKey: string; contextKey?: string }) => void)
          | undefined)
      : undefined;

    const requestHeartbeatNow = (api.runtime as Record<string, unknown>)?.system
      ? ((api.runtime as Record<string, Record<string, unknown>>).system.requestHeartbeatNow as
          | ((options?: { reason?: string; sessionKey?: string }) => void)
          | undefined)
      : undefined;

    if (!enqueueSystemEvent || !requestHeartbeatNow) {
      log.warn(
        "findoo-alpha: runtime.system APIs unavailable — async relay will not push progress. " +
          "Ensure gateway version ≥ 2026.2.0.",
      );
    }

    const expertManager = new ExpertManager({
      client,
      assistantId: config.strategyAssistantId,
      enqueueSystemEvent: enqueueSystemEvent ?? (() => {}),
      requestHeartbeatNow: requestHeartbeatNow ?? (() => {}),
      logger: log,
      maxConcurrentTasks: config.maxConcurrentTasks,
      taskStore,
    });

    // Health check (non-blocking)
    client
      .healthCheck()
      .then((ok) => {
        expertManager.setHealthy(ok);
        log.info(
          ok
            ? "findoo-alpha: strategy-agent reachable ✓"
            : "findoo-alpha: strategy-agent unreachable",
        );
      })
      .catch(() => {
        expertManager.setHealthy(false);
      });

    // Register tools
    registerTools(api, expertManager);

    // Recover in-flight tasks from previous session (non-blocking)
    expertManager.recoverTasks().catch((err) => {
      log.warn(`findoo-alpha: task recovery failed: ${err instanceof Error ? err.message : err}`);
    });

    // Dynamic prompt injection — pending task status
    if (typeof api.on === "function") {
      api.on("before_prompt_build", async () => {
        const pending = expertManager.getPendingTasks();
        const running = pending.filter((t) => t.status === "running");
        const healthy = expertManager.isHealthy();

        if (running.length > 0 || !healthy) {
          const lines = ["[Findoo Alpha 状态]"];
          if (!healthy) lines.push("⚠ 策略 Agent 连接异常，分析功能可能不可用");
          for (const t of running) {
            const elapsed = Math.round((Date.now() - t.submittedAt) / 1000);
            lines.push(`- 🔄 ${t.label}（已运行 ${elapsed}s）`);
          }
          return lines.join("\n");
        }
        return undefined;
      });
    }

    // Cross-plugin service (backward compat)
    api.runtime?.services?.set("fin-strategy-agent", {
      id: "fin-strategy-agent",
      getConfig: () => ({
        url: config.strategyAgentUrl,
        assistantId: config.strategyAssistantId,
      }),
      getExpertManager: () => expertManager,
    });
  },
};

export default findooPlugin;
