import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export type ProviderUsageMetricsSnapshot = Readonly<{
  generation: number;
  providers: readonly Readonly<{
    provider: string;
    windows: readonly Readonly<{
      window: string;
      usedRatio: number;
      resetTimestampSeconds?: number;
    }>[];
    lastAttemptTimestampSeconds?: number;
    lastSuccessTimestampSeconds?: number;
    refreshSuccess: boolean;
    refreshOutcome:
      | "success"
      | "timeout"
      | "auth"
      | "rate_limit"
      | "billing"
      | "format"
      | "unknown";
  }>[];
}>;

export type PrometheusExporterHealthUpdate = {
  signal: "metrics";
  transport: "prometheus-scrape";
  status: "started" | "dropped";
  reason?: "configured";
};

export type TrustedExporterDiagnosticsBridge = {
  emit: (event: {
    type: "telemetry.exporter";
    exporter: "diagnostics-prometheus";
    signal: "metrics";
    status: "started" | "dropped";
    reason?: "configured";
  }) => void;
  reportExporterHealth?: (update: PrometheusExporterHealthUpdate) => void;
  observeProviderUsage?: (
    listener: (snapshot: ProviderUsageMetricsSnapshot) => void,
  ) => Promise<() => void>;
};

const PROVIDER_USAGE_GAUGE_NAMES = new Set([
  "openclaw_provider_usage_used_ratio",
  "openclaw_provider_usage_reset_timestamp_seconds",
  "openclaw_provider_usage_last_success_timestamp_seconds",
  "openclaw_provider_usage_last_attempt_timestamp_seconds",
  "openclaw_provider_usage_refresh_success",
]);

export function recordProviderUsageSnapshot(
  store: PrometheusMetricStore,
  snapshot: ProviderUsageMetricsSnapshot,
): void {
  for (const name of PROVIDER_USAGE_GAUGE_NAMES) {
    store.clearGauges(name);
  }
  for (const provider of snapshot.providers) {
    const providerLabels = { provider: normalizeDiagnosticValue(provider.provider) };
    store.gauge(
      "openclaw_provider_usage_last_attempt_timestamp_seconds",
      "Unix timestamp of the latest provider allowance refresh attempt.",
      providerLabels,
      provider.lastAttemptTimestampSeconds,
    );
    store.gauge(
      "openclaw_provider_usage_last_success_timestamp_seconds",
      "Unix timestamp of the latest successful provider allowance refresh.",
      providerLabels,
      provider.lastSuccessTimestampSeconds,
    );
    store.gauge(
      "openclaw_provider_usage_refresh_success",
      "Whether the latest provider allowance refresh succeeded (1) or failed (0).",
      providerLabels,
      provider.refreshSuccess ? 1 : 0,
    );
    for (const window of provider.windows) {
      const labels = {
        ...providerLabels,
        window: normalizeDiagnosticValue(window.window),
      };
      store.gauge(
        "openclaw_provider_usage_used_ratio",
        "Latest provider-reported allowance fraction used.",
        labels,
        window.usedRatio,
      );
      store.gauge(
        "openclaw_provider_usage_reset_timestamp_seconds",
        "Unix timestamp when the provider allowance window resets.",
        labels,
        window.resetTimestampSeconds,
      );
    }
  }
}

export function createProviderUsageObserver(store: PrometheusMetricStore) {
  let generation = 0;
  let release: (() => void) | undefined;
  return {
    start(params: {
      bridge: TrustedExporterDiagnosticsBridge;
      enabled: boolean;
      onError: (error: unknown) => void;
    }): void {
      const startedGeneration = ++generation;
      const observeProviderUsage = params.bridge.observeProviderUsage;
      if (!params.enabled || !observeProviderUsage) {
        return;
      }
      void (async () => {
        const acquired = await observeProviderUsage((snapshot) => {
          if (startedGeneration !== generation) {
            return;
          }
          try {
            recordProviderUsageSnapshot(store, snapshot);
          } catch (error) {
            params.onError(error);
          }
        });
        if (startedGeneration !== generation) {
          acquired();
          return;
        }
        release = acquired;
      })().catch(params.onError);
    },
    stop(): void {
      generation += 1;
      release?.();
      release = undefined;
    },
  };
}
