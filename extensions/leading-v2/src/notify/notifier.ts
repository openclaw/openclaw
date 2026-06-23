import type { PluginLogger } from "../../api.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { BackendConfig } from "../client/types.js";
import { debugLog } from "./debug.js";
import type { PendingTaskRegistry } from "./pending-store.js";
import type { NotifyConfig, NotifyKind, PendingTask, PollAdapter } from "./types.js";

/** Delivers the finished-task summary to the user. Injected so the transport
 * (Mercure for the web deployment, or any future channel) stays out of the notifier. */
export type DeliverFn = (task: PendingTask, summary: string) => Promise<void>;

export interface CompletionNotifierDeps {
  registry: PendingTaskRegistry;
  resolver: ApiKeyResolver;
  config: BackendConfig;
  notify: NotifyConfig;
  deliver: DeliverFn;
  logger: PluginLogger;
  // Partial: a kind without a registered adapter is dropped in processOne, so
  // callers may wire only the kinds they actually poll.
  adapters: Partial<Record<NotifyKind, PollAdapter>>;
}

/**
 * Background service: polls each pending async task's backend status on an
 * interval and, when one reaches a terminal state, wakes the submitter's agent
 * (subagent.run with deliver:true) so it proactively reports the result to the
 * user's chat — removing the need for the user to keep asking "好了吗".
 */
export class CompletionNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: CompletionNotifierDeps) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const { notify, logger } = this.deps;
    this.timer = setInterval(() => {
      void this.tick();
    }, notify.pollIntervalMs);
    // Don't keep the event loop alive solely for this timer.
    this.timer.unref?.();
    logger.info(`[LEADING_V2_NOTIFY] Completion notifier started (every ${notify.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One polling pass. Public for tests; guarded against re-entrancy. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const { registry, notify } = this.deps;
      const pruned = registry.prune(Date.now());
      if (pruned > 0) {
        this.deps.logger.info(`[LEADING_V2_NOTIFY] Pruned ${pruned} expired task(s)`);
      }
      const pending = registry.all().filter((t) => !t.notified).slice(0, notify.maxPerTick);
      const total = registry.all().length;
      if (total > 0) {
        debugLog(`tick total=${total} polling=${pending.length}`);
      }
      for (const task of pending) {
        await this.processOne(task);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async processOne(task: PendingTask): Promise<void> {
    const { registry, resolver, config, adapters, deliver, logger } = this.deps;
    const adapter = adapters[task.kind];
    if (!adapter) {
      registry.remove(task.id);
      return;
    }
    let apiKey: string;
    try {
      apiKey = await resolver.getApiKey(task.uid);
    } catch (error) {
      logger.warn(`[LEADING_V2_NOTIFY] key resolution failed for ${task.uid}: ${String(error)}`);
      registry.update(task.id, { attempts: task.attempts + 1 });
      return;
    }

    let result: { terminal: boolean; summary: string };
    try {
      result = await adapter(task, apiKey, config);
    } catch (error) {
      registry.update(task.id, { attempts: task.attempts + 1 });
      debugLog(`poll id=${task.id} ERROR ${String(error)}`);
      logger.warn(`[LEADING_V2_NOTIFY] poll failed for ${task.id}: ${String(error)}`);
      return;
    }
    debugLog(`poll id=${task.id} terminal=${result.terminal}`);
    if (!result.terminal) {
      registry.update(task.id, { attempts: task.attempts + 1 });
      return;
    }

    // Mark notified BEFORE delivery so a crash mid-deliver can't double-notify
    // on the next tick; deliver, then remove.
    registry.update(task.id, { notified: true });
    try {
      await deliver(task, result.summary);
      debugLog(`deliver id=${task.id} OK uid=${task.uid}`);
      logger.info(`[LEADING_V2_NOTIFY] Notified ${task.uid} for task ${task.id}`);
    } catch (error) {
      debugLog(`deliver id=${task.id} ERROR ${String(error)}`);
      logger.error(`[LEADING_V2_NOTIFY] deliver failed for ${task.id}: ${String(error)}`);
    } finally {
      registry.remove(task.id);
    }
  }
}
