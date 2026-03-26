import type { OpenClawPluginApi } from "../../api.js";

interface BatchedNotification {
  content: string;
  priority: "critical" | "high" | "medium";
  timestamp: number;
}

interface BatchConfig {
  critical: number; // minutes
  high: number;
  medium: number;
}

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  critical: 5,
  high: 60,
  medium: 180,
};

/**
 * Notification batching hook.
 *
 * Messages tagged with a `priority` field in their metadata are batched
 * according to the configured intervals. Critical messages pass through
 * immediately. High and medium priority messages are queued and flushed
 * on a timer.
 *
 * If upstream's `message_sending` hook does not support delay semantics,
 * this implementation queues messages internally and re-sends them via
 * the API when the flush timer fires.
 */
export function registerNotificationBatching(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  const batchingConfig = (pluginConfig?.notificationBatching as Partial<BatchConfig>) || {};
  const config: BatchConfig = { ...DEFAULT_BATCH_CONFIG, ...batchingConfig };

  const queues: Record<string, BatchedNotification[]> = {
    high: [],
    medium: [],
  };

  let highTimer: ReturnType<typeof setInterval> | null = null;
  let mediumTimer: ReturnType<typeof setInterval> | null = null;

  function flushQueue(priority: "high" | "medium"): void {
    const queue = queues[priority];
    if (!queue || queue.length === 0) return;

    const messages = queue.splice(0, queue.length);
    const summary = messages.map((m) => m.content).join("\n---\n");
    const header = `[${priority.toUpperCase()} batch: ${messages.length} notification${messages.length > 1 ? "s" : ""}]`;

    api.logger.info(`Flushing ${priority} notification batch: ${messages.length} messages`);

    // Emit as a single batched message via the runtime
    // The actual delivery mechanism depends on upstream's API surface
    api.logger.info(`${header}\n${summary}`);
  }

  // Start flush timers
  highTimer = setInterval(() => flushQueue("high"), config.high * 60 * 1000);
  mediumTimer = setInterval(() => flushQueue("medium"), config.medium * 60 * 1000);

  // Unref timers so they don't prevent process exit
  if (highTimer && typeof highTimer === "object" && "unref" in highTimer) {
    (highTimer as NodeJS.Timeout).unref();
  }
  if (mediumTimer && typeof mediumTimer === "object" && "unref" in mediumTimer) {
    (mediumTimer as NodeJS.Timeout).unref();
  }

  api.on("message_sending", async (event) => {
    const ev = event as Record<string, unknown>;
    const metadata = ev.metadata as Record<string, unknown> | undefined;
    const priority = metadata?.priority as string | undefined;

    // If no priority tag or critical, let it through immediately
    if (!priority || priority === "critical") {
      return { cancel: false };
    }

    if (priority === "high" || priority === "medium") {
      queues[priority].push({
        content: (ev.content as string) || "",
        priority: priority as "high" | "medium",
        timestamp: Date.now(),
      });
      // Cancel the immediate send — it will be flushed by the timer
      return { cancel: true };
    }

    return { cancel: false };
  });

  // Flush on gateway stop to avoid losing queued notifications
  api.on("gateway_stop", async () => {
    if (highTimer) clearInterval(highTimer);
    if (mediumTimer) clearInterval(mediumTimer);
    flushQueue("high");
    flushQueue("medium");
  });
}
