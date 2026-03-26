import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { TaskExecutor } from "./task-executor.js";
import { ArchonTaskBackend, TaskPoller } from "./task-poller.js";
import type { WorkerConfig } from "./types.js";

export default definePluginEntry({
  id: "distributed-workers",
  name: "Distributed Workers",
  description: "Multi-node task execution with claim arbitration and worktree isolation",
  register(api) {
    const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;

    const config: WorkerConfig = {
      nodeName: (pluginConfig?.nodeName as string) || process.env.WORKER_NODE_NAME || "unknown",
      maxThreads:
        (pluginConfig?.maxThreads as number) || Number(process.env.WORKER_MAX_THREADS || "4"),
      pollIntervalMs:
        (pluginConfig?.pollIntervalMs as number) ||
        Number(process.env.WORKER_POLL_INTERVAL || "30") * 1000,
      worktreeBaseDir:
        (pluginConfig?.worktreeBaseDir as string) ||
        process.env.WORKTREE_BASE_DIR ||
        "/repo/worktrees",
      repoDir: (pluginConfig?.repoDir as string) || process.env.WORKTREE_REPO_DIR || "/repo",
      archonUrl: process.env.ARCHON_SERVER_URL || "http://100.69.32.10:8181",
      archonProjectId: process.env.ARCHON_PROJECT_ID || "",
    };

    // If maxThreads is 0, the extension loads but does not start the worker loop
    if (config.maxThreads <= 0) {
      api.logger.info(
        `distributed-workers loaded on ${config.nodeName} but disabled (maxThreads=0)`,
      );
      return;
    }

    if (!config.archonProjectId) {
      api.logger.warn("distributed-workers: ARCHON_PROJECT_ID not set, worker disabled");
      return;
    }

    const backend = new ArchonTaskBackend(config.archonUrl, config.archonProjectId);
    const executor = new TaskExecutor(config, backend);

    // Recover stale worktrees from previous crashes
    executor.recoverStale().then((stale) => {
      if (stale.length > 0) {
        api.logger.warn(`Recovered ${stale.length} stale worktrees: ${stale.join(", ")}`);
      }
    });

    // Start polling
    const poller = new TaskPoller(backend, config.nodeName, config.pollIntervalMs, async (task) => {
      if (executor.canAcceptTask) {
        // Fire and forget — executor handles its own lifecycle
        executor.tryExecute(task).catch((err) => {
          api.logger.error(`Task execution error: ${err}`);
        });
      }
    });

    poller.start();

    // Periodic stale cleanup (hourly)
    const cleanupTimer = setInterval(() => executor.recoverStale().catch(() => {}), 60 * 60 * 1000);
    if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
      (cleanupTimer as NodeJS.Timeout).unref();
    }

    // Graceful shutdown
    api.on("gateway_stop", async () => {
      poller.stop();
      clearInterval(cleanupTimer);
      api.logger.info(
        `distributed-workers shutting down on ${config.nodeName}, ${executor.activeCount} tasks in flight`,
      );
    });

    api.logger.info(
      `distributed-workers started on ${config.nodeName}: ${config.maxThreads} threads, polling every ${config.pollIntervalMs / 1000}s`,
    );
  },
});
