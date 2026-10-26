import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { prepareMemoryManagerReload, retainMemoryIndexingAgents } from "./lifecycle.js";
import type { MemoryCoreRuntimeHost } from "./runtime-host.js";

/** One registration's index lifetime, shared by service restarts and final disposal. */
export function createMemoryIndexLifecycle(
  memoryRuntime: MemoryPluginRuntime,
  runInBackgroundContext: MemoryCoreRuntimeHost["runInBackgroundContext"],
) {
  let startup: Promise<void> | undefined;
  const settleAndClose = async (close: () => Promise<void> | undefined) => {
    const errors: unknown[] = [];
    for (const settle of [() => startup, close]) {
      try {
        await settle();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Memory index shutdown failed");
    }
  };
  const start: OpenClawPluginService["start"] = ({ config, logger }) => {
    // Restore watched indexes without opening untouched agents' databases and workers.
    const agentIds = retainMemoryIndexingAgents(listAgentIds(config));
    if (agentIds.length === 0) {
      return;
    }
    const activate = async () => {
      await Promise.all(
        agentIds.map(async (agentId) => {
          const { error } = await memoryRuntime
            .getMemorySearchManager({ cfg: config, agentId })
            .catch((cause: unknown) => ({ error: String(cause) }));
          if (error) {
            logger.warn(`memory-core: index startup failed for ${agentId}: ${error}`);
          }
        }),
      );
    };
    // Database preparation starts after services return; joining here deadlocks startup.
    startup = runInBackgroundContext ? runInBackgroundContext(activate) : activate();
    // Forced retirement may reject before the cleanup owner reaches this task.
    void startup.catch(() => {});
  };
  return {
    start,
    stop: () => settleAndClose(() => memoryRuntime.closeAllMemorySearchManagers?.()),
    dispose: async () => {
      const retirement = prepareMemoryManagerReload({
        retireRuntime: true,
        retiringEmbeddingProviders: [],
      });
      await settleAndClose(async () => {
        const result = await retirement.drain();
        if (result?.errors.length) {
          throw new AggregateError(result.errors, "Memory manager disposal failed");
        }
      });
    },
  };
}
