import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import type { TrustedExporterInternalDiagnostics } from "./service.test-helpers.js";

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
  it("declares diagnostics enablement as a service replacement boundary", () => {
    const exporter = createDiagnosticsPrometheusExporter();

    expect(exporter.service.reload).toEqual({ configPrefixes: ["diagnostics.enabled"] });
  });

  it("does not acquire provider usage while diagnostics are disabled", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const observeProviderUsage = vi.fn();
    await exporter.service.start({
      config: { diagnostics: { enabled: false } } as never,
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
    expect(exporter.render()).toBe("");
  });

  it("renders cache-owned provider usage and withdraws stale series", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();
    let publish: ProviderUsageListener | undefined;
    await exporter.service.start({
      config: {} as never,
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
          windows: [{ window: "5h", usedRatio: 0.15, resetTimestampSeconds: 1_700_003_600 }],
          lastAttemptTimestampSeconds: 1_700_000_000,
          lastSuccessTimestampSeconds: 1_700_000_001,
          refreshSuccess: true,
          refreshOutcome: "success",
        },
      ],
    });
    expect(exporter.render()).toContain(
      'openclaw_provider_usage_used_ratio{provider="openai",window="5h"} 0.15',
    );
    expect(exporter.render()).toContain(
      'openclaw_provider_usage_refresh_success{provider="openai"} 1',
    );

    expectDefined(publish, "provider usage listener")({ generation: 2, providers: [] });
    expect(exporter.render()).not.toContain("openclaw_provider_usage_");

    exporter.service.stop?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("releases and reacquires provider usage across diagnostics replacement", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const listeners: ProviderUsageListener[] = [];
    const releases = [vi.fn(), vi.fn()];
    const observeProviderUsage = vi.fn(async (listener: ProviderUsageListener) => {
      listeners.push(listener);
      return expectDefined(releases[listeners.length - 1], "provider usage release");
    });
    const context = (enabled: boolean) => ({
      config: { diagnostics: { enabled } } as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
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

    await exporter.service.start(context(true));
    expect(observeProviderUsage).toHaveBeenCalledOnce();
    expectDefined(listeners[0], "initial provider usage listener")(snapshot);
    expect(exporter.render()).toContain("openclaw_provider_usage_used_ratio");

    await exporter.service.stop?.();
    await exporter.service.start(context(false));
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(observeProviderUsage).toHaveBeenCalledOnce();
    expect(exporter.render()).not.toContain("openclaw_provider_usage_");

    expectDefined(listeners[0], "retired provider usage listener")(snapshot);
    expect(exporter.render()).not.toContain("openclaw_provider_usage_");

    await exporter.service.stop?.();
    await exporter.service.start(context(true));
    expect(observeProviderUsage).toHaveBeenCalledTimes(2);
    expectDefined(listeners[1], "replacement provider usage listener")(snapshot);
    expect(exporter.render()).toContain("openclaw_provider_usage_used_ratio");

    await exporter.service.stop?.();
    expect(releases[1]).toHaveBeenCalledOnce();
  });
});
