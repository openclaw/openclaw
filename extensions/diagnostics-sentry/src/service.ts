import * as Sentry from "@sentry/node";
import type { DiagnosticCronFinishedEvent, OpenClawPluginService } from "../api.js";
import { onDiagnosticEvent, redactSensitiveText } from "../api.js";

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export type DiagnosticsSentryConfig = {
  enabled?: boolean;
  dsn?: string;
  environment?: string;
  release?: string;
  serverName?: string;
  flushTimeoutMs?: number;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseDiagnosticsSentryConfig(value: unknown): DiagnosticsSentryConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled:
      typeof (record as { enabled?: unknown }).enabled === "boolean"
        ? (record as { enabled: boolean }).enabled
        : undefined,
    dsn: asNonEmptyString((record as { dsn?: unknown }).dsn),
    environment: asNonEmptyString((record as { environment?: unknown }).environment),
    release: asNonEmptyString((record as { release?: unknown }).release),
    serverName: asNonEmptyString((record as { serverName?: unknown }).serverName),
    flushTimeoutMs:
      typeof (record as { flushTimeoutMs?: unknown }).flushTimeoutMs === "number" &&
      Number.isFinite((record as { flushTimeoutMs: number }).flushTimeoutMs)
        ? Math.max(1, Math.floor((record as { flushTimeoutMs: number }).flushTimeoutMs))
        : undefined,
  };
}

function buildCronFailureFingerprint(event: DiagnosticCronFinishedEvent): string[] {
  const fingerprint = ["openclaw", "cron", "job-failure", event.jobId];
  if (event.provider) {
    fingerprint.push(event.provider);
  }
  return fingerprint;
}

function normalizeCronFailureError(event: DiagnosticCronFinishedEvent): Error {
  const base = event.error?.trim() || `Cron job "${event.jobName ?? event.jobId}" failed`;
  const error = new Error(base);
  error.name = "OpenClawCronFailureError";
  return error;
}

export function createDiagnosticsSentryService(
  config: DiagnosticsSentryConfig,
): OpenClawPluginService {
  let unsubscribe: (() => void) | null = null;
  let active = false;

  return {
    id: "diagnostics-sentry",
    async start(ctx) {
      if (config.enabled === false) {
        return;
      }
      if (!config.dsn) {
        return;
      }

      Sentry.init({
        dsn: config.dsn,
        environment: config.environment,
        release: config.release,
        serverName: config.serverName,
        sendDefaultPii: false,
      });
      active = true;

      unsubscribe = onDiagnosticEvent((event) => {
        if (event.type !== "cron.finished" || event.status !== "error") {
          return;
        }
        const error = normalizeCronFailureError(event);
        try {
          Sentry.captureException(error, {
            level: "error",
            tags: {
              subsystem: "cron",
              job_id: event.jobId,
              job_name: event.jobName ?? event.jobId,
              status: event.status,
              delivery_status: event.deliveryStatus ?? "unknown",
              provider: event.provider ?? "unknown",
              model: event.model ?? "unknown",
            },
            extra: {
              summary: event.summary ? redactSensitiveText(event.summary) : undefined,
              error: event.error ? redactSensitiveText(event.error) : undefined,
              sessionId: event.sessionId,
              sessionKey: event.sessionKey,
              runAtMs: event.runAtMs,
              durationMs: event.durationMs,
              nextRunAtMs: event.nextRunAtMs,
              delivered: event.delivered,
              deliveryError: event.deliveryError
                ? redactSensitiveText(event.deliveryError)
                : undefined,
            },
            fingerprint: buildCronFailureFingerprint(event),
          });
        } catch (err) {
          ctx.logger.error(
            `diagnostics-sentry: failed to capture cron event: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (!active) {
        return;
      }
      active = false;
      await Sentry.close(config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS).catch(() => undefined);
    },
  } satisfies OpenClawPluginService;
}
