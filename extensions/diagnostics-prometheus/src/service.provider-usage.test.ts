import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  baseEvent,
  trusted,
  type TrustedExporterInternalDiagnostics,
} from "./service.test-helpers.js";

type ProviderUsageListener = (snapshot: {
  generation: number;
  providers: readonly {
    provider: string;
    windows: readonly {
      window: string;
      usedRatio: number;
      resetTimestampSeconds?: number;
    }[];
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
  }[];
}) => void;

describe("diagnostics-prometheus provider usage", () => {
  const config = (diagnosticsEnabled: boolean, providerUsageEnabled: boolean) => ({
    diagnostics: { enabled: diagnosticsEnabled },
    plugins: {
      entries: {
        "diagnostics-prometheus": {
          config: { providerUsage: { enabled: providerUsageEnabled } },
        },
      },
    },
  });

  it("does not acquire provider usage while diagnostics are disabled", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const observeProviderUsage = vi.fn();
    exporter.service.start({
      config: config(false, true) as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage,
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    expect(observeProviderUsage).not.toHaveBeenCalled();
    expect(Buffer.from(exporter.render()).toString("utf8")).toBe("");
  });

  it("does not acquire provider usage without explicit opt-in", () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const observeProviderUsage = vi.fn();
    exporter.service.start({
      config: { diagnostics: { enabled: true } } as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage,
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    expect(observeProviderUsage).not.toHaveBeenCalled();
    exporter.service.stop?.();
  });

  it("reports provider usage acquisition failures without rejecting service startup", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const error = vi.fn();
    exporter.service.start({
      config: config(true, true) as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage: async () => {
          throw new Error("acquisition failed");
        },
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "diagnostics-prometheus: provider usage handler failed: acquisition failed",
      ),
    );
    exporter.service.stop?.();
  });

  it("renders cache-owned provider usage and withdraws stale series", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();
    let publish: ProviderUsageListener | undefined;
    exporter.service.start({
      config: config(true, true) as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage: async (listener: ProviderUsageListener) => {
          publish = listener;
          return unsubscribe;
        },
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    expectDefined(
      publish,
      "provider usage listener",
    )({
      generation: 1,
      providers: [
        {
          provider: "openai",
          windows: [
            {
              window: "tokens_6h",
              usedRatio: 0.32,
              resetTimestampSeconds: 1_700_003_600,
            },
            {
              window: "tokens_15m",
              usedRatio: 0.08,
              resetTimestampSeconds: 1_700_000_900,
            },
          ],
          lastAttemptTimestampSeconds: 1_700_000_000,
          lastSuccessTimestampSeconds: 1_700_000_001,
          refreshSuccess: true,
          refreshOutcome: "success",
        },
      ],
    });
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_provider_usage_used_ratio{provider="openai",window="tokens_6h"} 0.32',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_provider_usage_used_ratio{provider="openai",window="tokens_15m"} 0.08',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_provider_usage_reset_timestamp_seconds{provider="openai",window="tokens_6h"} 1700003600',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_provider_usage_reset_timestamp_seconds{provider="openai",window="tokens_15m"} 1700000900',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_provider_usage_refresh_success{provider="openai"} 1',
    );

    expectDefined(publish, "provider usage listener")({ generation: 2, providers: [] });
    expect(Buffer.from(exporter.render()).toString("utf8")).not.toContain(
      "openclaw_provider_usage_",
    );

    exporter.service.stop?.();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("preserves accumulated metrics across diagnostics replacement", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const listeners: ProviderUsageListener[] = [];
    const releases = [vi.fn(), vi.fn()];
    let diagnosticListener:
      | Parameters<TrustedExporterInternalDiagnostics["onEvent"]>[0]
      | undefined;
    const observeProviderUsage = vi.fn(async (listener: ProviderUsageListener) => {
      listeners.push(listener);
      return expectDefined(releases[listeners.length - 1], "provider usage release");
    });
    const context = (diagnosticsEnabled: boolean, providerUsageEnabled: boolean) => ({
      config: config(diagnosticsEnabled, providerUsageEnabled) as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: (listener) => {
          diagnosticListener = listener;
          return vi.fn();
        },
        observeProviderUsage,
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });
    const snapshot = {
      generation: 1,
      providers: [
        {
          provider: "openai",
          windows: [{ window: "5h", usedRatio: 0.15 }],
          refreshSuccess: true,
          refreshOutcome: "success" as const,
        },
      ],
    };

    const enabledContext = context(true, true);
    exporter.service.start(enabledContext);
    expect(observeProviderUsage).toHaveBeenCalledOnce();
    expectDefined(listeners[0], "initial provider usage listener")(snapshot);
    expectDefined(diagnosticListener, "diagnostics listener")(
      { ...baseEvent(), type: "gateway.rpc", method: "models.list", phase: "received" },
      trusted,
      {},
    );
    expectDefined(diagnosticListener, "diagnostics listener")(
      { ...baseEvent(), type: "queue.lane.enqueue", lane: "main", queueSize: 7 },
      trusted,
      {},
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      "openclaw_provider_usage_used_ratio",
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_gateway_rpc_requests_total{method="models.list"} 1',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_queue_lane_size{lane="main"} 7',
    );

    exporter.service.stop?.({ ...enabledContext, stopReason: "reload" });
    const disabledContext = context(false, true);
    exporter.service.start(disabledContext);
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledOnce());
    expect(observeProviderUsage).toHaveBeenCalledOnce();
    expect(Buffer.from(exporter.render()).toString("utf8")).toBe("");

    expectDefined(listeners[0], "retired provider usage listener")(snapshot);
    expect(Buffer.from(exporter.render()).toString("utf8")).toBe("");

    exporter.service.stop?.({ ...disabledContext, stopReason: "reload" });
    exporter.service.start(context(true, true));
    expect(observeProviderUsage).toHaveBeenCalledTimes(2);
    expectDefined(listeners[1], "replacement provider usage listener")(snapshot);
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      "openclaw_provider_usage_used_ratio",
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).toContain(
      'openclaw_gateway_rpc_requests_total{method="models.list"} 1',
    );
    expect(Buffer.from(exporter.render()).toString("utf8")).not.toContain(
      "openclaw_queue_lane_size",
    );

    exporter.service.stop?.();
    await vi.waitFor(() => expect(releases[1]).toHaveBeenCalledOnce());
  });
});
