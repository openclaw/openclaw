/**
 * Prometheus diagnostics service.
 *
 * Dual-mode operation:
 * 1. Pull mode: Exposes /metrics HTTP endpoint for Prometheus scraping (via prom-client)
 * 2. Push mode: Sends metrics via Prometheus Remote Write protocol (protobuf + snappy)
 *
 * Both modes can be enabled simultaneously.
 */

import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/diagnostics-otel";
import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostics-otel";
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import type { PromTimeSeries, PromLabel } from "./protobuf.js";
import { RemoteWriteClient, type RemoteWriteConfig } from "./remote-write.js";

export type PrometheusConfig = {
  enabled?: boolean;
  /** Metric name prefix. Default: "openclaw" */
  metric_prefix?: string;
  /** Enable /metrics pull endpoint. Default: true */
  pull?: boolean;
  /** Enable Node.js default metrics (GC, event loop, etc). Default: true */
  default_metrics?: boolean;
  /** Custom labels added to all metrics */
  external_labels?: Record<string, string>;
  /** Remote write targets. Supports multiple endpoints. */
  remote_write?: RemoteWriteConfig[];
  /** Push interval for remote write in ms. Default: 15000 */
  push_interval_ms?: number;
};

export type PrometheusPluginExports = {
  registry: Registry;
};

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return typeof err === "string" ? err : String(err);
}

export function createPrometheusService(): OpenClawPluginService & {
  getExports: () => PrometheusPluginExports | null;
} {
  let registry: Registry | null = null;
  let unsubscribe: (() => void) | null = null;
  let remoteWriteClients: RemoteWriteClient[] = [];
  let pushTimer: ReturnType<typeof setInterval> | null = null;
  let exports: PrometheusPluginExports | null = null;

  return {
    id: "diagnostics-prometheus",

    getExports() {
      return exports;
    },

    async start(ctx: OpenClawPluginServiceContext) {
      const diagCfg = ctx.config.diagnostics;
      const promCfg = diagCfg?.prometheus as PrometheusConfig | undefined;

      if (!diagCfg?.enabled || !promCfg?.enabled) {
        return;
      }

      const prefix = promCfg.metric_prefix ?? "openclaw";
      const externalLabels = promCfg.external_labels ?? {};

      // Initialize prom-client registry
      registry = new Registry();

      if (promCfg.default_metrics !== false) {
        collectDefaultMetrics({ register: registry, prefix: `${prefix}_node_` });
      }

      // ---- Define metrics ----

      const tokensTotal = new Counter({
        name: `${prefix}_tokens_total`,
        help: "Total tokens consumed",
        labelNames: ["type", "provider", "model", "channel"],
        registers: [registry],
      });

      const costUsdTotal = new Counter({
        name: `${prefix}_cost_usd_total`,
        help: "Estimated model cost in USD",
        labelNames: ["provider", "model"],
        registers: [registry],
      });

      const runDurationMs = new Histogram({
        name: `${prefix}_run_duration_ms`,
        help: "Agent run duration in milliseconds",
        labelNames: ["provider", "model"],
        buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
        registers: [registry],
      });

      const contextTokens = new Histogram({
        name: `${prefix}_context_tokens`,
        help: "Context window token count",
        labelNames: ["provider", "model", "type"],
        buckets: [1000, 4000, 8000, 16000, 32000, 64000, 128000, 200000],
        registers: [registry],
      });

      const webhookReceivedTotal = new Counter({
        name: `${prefix}_webhook_received_total`,
        help: "Webhook requests received",
        labelNames: ["channel", "update_type"],
        registers: [registry],
      });

      const webhookErrorTotal = new Counter({
        name: `${prefix}_webhook_error_total`,
        help: "Webhook processing errors",
        labelNames: ["channel", "update_type"],
        registers: [registry],
      });

      const webhookDurationMs = new Histogram({
        name: `${prefix}_webhook_duration_ms`,
        help: "Webhook processing duration in milliseconds",
        labelNames: ["channel", "update_type"],
        buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
        registers: [registry],
      });

      const messageQueuedTotal = new Counter({
        name: `${prefix}_message_queued_total`,
        help: "Messages queued for processing",
        labelNames: ["channel", "source"],
        registers: [registry],
      });

      const messageProcessedTotal = new Counter({
        name: `${prefix}_message_processed_total`,
        help: "Messages processed by outcome",
        labelNames: ["channel", "outcome"],
        registers: [registry],
      });

      const messageDurationMs = new Histogram({
        name: `${prefix}_message_duration_ms`,
        help: "Message processing duration in milliseconds",
        labelNames: ["channel", "outcome"],
        buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000],
        registers: [registry],
      });

      const queueDepth = new Gauge({
        name: `${prefix}_queue_depth`,
        help: "Current queue depth per lane",
        labelNames: ["lane"],
        registers: [registry],
      });

      const queueWaitMs = new Histogram({
        name: `${prefix}_queue_wait_ms`,
        help: "Queue wait time before execution in milliseconds",
        labelNames: ["lane"],
        buckets: [10, 50, 100, 500, 1000, 5000, 10000],
        registers: [registry],
      });

      const laneEnqueueTotal = new Counter({
        name: `${prefix}_queue_lane_enqueue_total`,
        help: "Queue lane enqueue events",
        labelNames: ["lane"],
        registers: [registry],
      });

      const laneDequeueTotal = new Counter({
        name: `${prefix}_queue_lane_dequeue_total`,
        help: "Queue lane dequeue events",
        labelNames: ["lane"],
        registers: [registry],
      });

      const sessionStateTotal = new Counter({
        name: `${prefix}_session_state_total`,
        help: "Session state transitions",
        labelNames: ["state", "reason"],
        registers: [registry],
      });

      const sessionStuckTotal = new Counter({
        name: `${prefix}_session_stuck_total`,
        help: "Sessions detected as stuck",
        labelNames: ["state"],
        registers: [registry],
      });

      const sessionStuckAgeMs = new Histogram({
        name: `${prefix}_session_stuck_age_ms`,
        help: "Age of stuck sessions in milliseconds",
        labelNames: ["state"],
        buckets: [1000, 5000, 10000, 30000, 60000, 120000, 300000],
        registers: [registry],
      });

      const runAttemptTotal = new Counter({
        name: `${prefix}_run_attempt_total`,
        help: "Agent run attempts",
        labelNames: ["attempt"],
        registers: [registry],
      });

      const activeSessions = new Gauge({
        name: `${prefix}_active_sessions`,
        help: "Number of currently active sessions",
        registers: [registry],
      });

      const waitingSessions = new Gauge({
        name: `${prefix}_waiting_sessions`,
        help: "Number of sessions in waiting state",
        registers: [registry],
      });

      const queuedMessages = new Gauge({
        name: `${prefix}_queued_messages`,
        help: "Total messages currently queued",
        registers: [registry],
      });

      const toolLoopTotal = new Counter({
        name: `${prefix}_tool_loop_total`,
        help: "Tool loop detections",
        labelNames: ["tool", "detector", "level", "action"],
        registers: [registry],
      });

      // ---- Event handler ----

      const handleEvent = (evt: DiagnosticEventPayload) => {
        try {
          switch (evt.type) {
            case "model.usage": {
              const labels = {
                provider: evt.provider ?? "unknown",
                model: evt.model ?? "unknown",
                channel: evt.channel ?? "unknown",
              };
              const usage = evt.usage;
              if (usage.input) {
                tokensTotal.inc({ ...labels, type: "input" }, usage.input);
              }
              if (usage.output) {
                tokensTotal.inc({ ...labels, type: "output" }, usage.output);
              }
              if (usage.cacheRead) {
                tokensTotal.inc({ ...labels, type: "cache_read" }, usage.cacheRead);
              }
              if (usage.cacheWrite) {
                tokensTotal.inc({ ...labels, type: "cache_write" }, usage.cacheWrite);
              }
              if (usage.promptTokens) {
                tokensTotal.inc({ ...labels, type: "prompt" }, usage.promptTokens);
              }
              if (usage.total) {
                tokensTotal.inc({ ...labels, type: "total" }, usage.total);
              }
              if (evt.costUsd) {
                costUsdTotal.inc({ provider: labels.provider, model: labels.model }, evt.costUsd);
              }
              if (evt.durationMs) {
                runDurationMs.observe(
                  { provider: labels.provider, model: labels.model },
                  evt.durationMs,
                );
              }
              if (evt.context?.limit) {
                contextTokens.observe(
                  { provider: labels.provider, model: labels.model, type: "limit" },
                  evt.context.limit,
                );
              }
              if (evt.context?.used) {
                contextTokens.observe(
                  { provider: labels.provider, model: labels.model, type: "used" },
                  evt.context.used,
                );
              }
              break;
            }

            case "webhook.received": {
              webhookReceivedTotal.inc({
                channel: evt.channel ?? "unknown",
                update_type: evt.updateType ?? "unknown",
              });
              break;
            }

            case "webhook.processed": {
              if (typeof evt.durationMs === "number") {
                webhookDurationMs.observe(
                  {
                    channel: evt.channel ?? "unknown",
                    update_type: evt.updateType ?? "unknown",
                  },
                  evt.durationMs,
                );
              }
              break;
            }

            case "webhook.error": {
              webhookErrorTotal.inc({
                channel: evt.channel ?? "unknown",
                update_type: evt.updateType ?? "unknown",
              });
              break;
            }

            case "message.queued": {
              messageQueuedTotal.inc({
                channel: evt.channel ?? "unknown",
                source: evt.source ?? "unknown",
              });
              break;
            }

            case "message.processed": {
              messageProcessedTotal.inc({
                channel: evt.channel ?? "unknown",
                outcome: evt.outcome ?? "unknown",
              });
              if (typeof evt.durationMs === "number") {
                messageDurationMs.observe(
                  {
                    channel: evt.channel ?? "unknown",
                    outcome: evt.outcome ?? "unknown",
                  },
                  evt.durationMs,
                );
              }
              break;
            }

            case "queue.lane.enqueue": {
              laneEnqueueTotal.inc({ lane: evt.lane });
              queueDepth.set({ lane: evt.lane }, evt.queueSize);
              break;
            }

            case "queue.lane.dequeue": {
              laneDequeueTotal.inc({ lane: evt.lane });
              queueDepth.set({ lane: evt.lane }, evt.queueSize);
              if (typeof evt.waitMs === "number") {
                queueWaitMs.observe({ lane: evt.lane }, evt.waitMs);
              }
              break;
            }

            case "session.state": {
              sessionStateTotal.inc({
                state: evt.state,
                reason: evt.reason ?? "",
              });
              break;
            }

            case "session.stuck": {
              sessionStuckTotal.inc({ state: evt.state });
              if (typeof evt.ageMs === "number") {
                sessionStuckAgeMs.observe({ state: evt.state }, evt.ageMs);
              }
              break;
            }

            case "run.attempt": {
              runAttemptTotal.inc({ attempt: String(evt.attempt) });
              break;
            }

            case "diagnostic.heartbeat": {
              activeSessions.set(evt.active);
              waitingSessions.set(evt.waiting);
              queuedMessages.set(evt.queued);
              break;
            }

            case "tool.loop": {
              toolLoopTotal.inc({
                tool: evt.toolName,
                detector: evt.detector,
                level: evt.level,
                action: evt.action,
              });
              break;
            }
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-prometheus: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      };

      // Subscribe to diagnostic events
      unsubscribe = onDiagnosticEvent(handleEvent);

      // ---- Remote Write setup ----
      const remoteWriteConfigs = promCfg.remote_write ?? [];
      remoteWriteClients = remoteWriteConfigs
        .filter((rw) => rw.url)
        .map((rw) => new RemoteWriteClient(rw, ctx.logger));

      if (remoteWriteClients.length > 0) {
        const pushIntervalMs = promCfg.push_interval_ms ?? 15_000;
        pushTimer = setInterval(() => {
          void pushMetrics(registry!, remoteWriteClients, externalLabels, ctx.logger);
        }, pushIntervalMs);

        ctx.logger.info(
          `diagnostics-prometheus: remote write enabled for ${remoteWriteClients.length} target(s), push interval ${pushIntervalMs}ms`,
        );
      }

      exports = promCfg.pull !== false ? { registry } : null;

      ctx.logger.info(
        `diagnostics-prometheus: started (pull=${promCfg.pull !== false}, remote_write=${remoteWriteClients.length} targets)`,
      );
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;

      if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
      }

      // Final flush on stop
      for (const client of remoteWriteClients) {
        await client.stop().catch(() => undefined);
      }
      remoteWriteClients = [];

      if (registry) {
        registry.clear();
        registry = null;
      }
      exports = null;
    },
  } satisfies OpenClawPluginService & { getExports: () => PrometheusPluginExports | null };
}

/**
 * Collect all prom-client metrics and push via Remote Write.
 */
async function pushMetrics(
  registry: Registry,
  clients: RemoteWriteClient[],
  externalLabels: Record<string, string>,
  logger: Logger,
): Promise<void> {
  if (clients.length === 0) {
    return;
  }

  try {
    const metricsJson = await registry.getMetricsAsJSON();
    const now = Date.now();
    const timeseries: PromTimeSeries[] = [];

    for (const metric of metricsJson) {
      const metricName = metric.name;
      const values = metric.values;

      for (const val of values) {
        const labels: PromLabel[] = [{ name: "__name__", value: metricName }];

        // Add external labels
        for (const [k, v] of Object.entries(externalLabels)) {
          labels.push({ name: k, value: v });
        }

        // Add metric labels
        if (val.labels) {
          for (const [k, v] of Object.entries(val.labels as Record<string, string>)) {
            labels.push({ name: k, value: String(v) });
          }
        }

        // Sort labels by name (Prometheus convention)
        labels.sort((a, b) => a.name.localeCompare(b.name));

        // Handle histograms: prom-client reports _bucket, _sum, _count as separate values
        timeseries.push({
          labels,
          samples: [{ value: val.value ?? 0, timestampMs: now }],
        });
      }
    }

    if (timeseries.length === 0) {
      return;
    }

    for (const client of clients) {
      client.enqueue(timeseries);
    }
  } catch (err) {
    logger.error(`diagnostics-prometheus: failed to collect metrics for push: ${formatError(err)}`);
  }
}

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};
