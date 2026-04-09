/** Plugin config for inference-guard. */
export type InferenceGuardConfig = {
  /** Maximum concurrent inference requests. Default: 1. */
  maxConcurrentInference: number;

  /** Deferral policy for different request types. */
  deferPolicy: {
    /** Heartbeat deferral. Default: defer-behind-user, maxQueued: 1. */
    heartbeat: { action: "defer-behind-user" | "queue-fifo"; maxQueued: number };
    /** Cron job deferral. Default: defer-behind-user, maxQueued: 3. */
    cron: { action: "defer-behind-user" | "queue-fifo"; maxQueued: number };
    /** Subagent deferral. Default: queue-fifo. */
    subagent: { action: "queue-fifo" };
  };

  /** Warning threshold in ms for queued requests. Default: 5000. */
  queueWarnMs: number;
};
