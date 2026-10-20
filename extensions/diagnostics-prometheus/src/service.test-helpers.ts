import { once } from "node:events";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginServiceContext,
} from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";

export const trusted: DiagnosticEventMetadata = Object.freeze({ trusted: true });
export const untrusted: DiagnosticEventMetadata = Object.freeze({ trusted: false });

export function expectMetrics(actual: string | readonly string[]) {
  const lines = typeof actual === "string" ? actual.split("\n") : actual;
  return (samples: string) => {
    for (const sample of samples.trim().split("\n")) {
      expect(lines).toContain(sample.trim());
    }
  };
}

export function expectExcludes(actual: string, ...samples: string[]) {
  samples.forEach((sample) => expect(actual).not.toContain(sample));
}
type EventInput<T = DiagnosticEventPayload> = T extends DiagnosticEventPayload
  ? Omit<T, "seq" | "ts">
  : never;
export type ExporterHealthReport = {
  signal: "metrics";
  transport: "prometheus-scrape";
  status: "started" | "dropped";
  reason?: "configured";
};
export type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: ExporterHealthReport) => void;
};
const noop = () => {};

export const baseEvent = () => ({ seq: 1, ts: 1700000000000 });

export function createMetricsHarness(
  getRuntimeIdentity?: TrustedExporterInternalDiagnostics["getRuntimeIdentity"],
  config: OpenClawPluginServiceContext["config"] = {},
  onGatewayWorkMetrics?: TrustedExporterInternalDiagnostics["onGatewayWorkMetrics"],
) {
  const exporter = createDiagnosticsPrometheusExporter();
  let listener: Parameters<TrustedExporterInternalDiagnostics["onEvent"]>[0] | undefined;
  const start = () =>
    exporter.service.start({
      config,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      internalDiagnostics: {
        ...(getRuntimeIdentity ? { getRuntimeIdentity } : {}),
        ...(onGatewayWorkMetrics ? { onGatewayWorkMetrics } : {}),
        emit: noop,
        onEvent(nextListener) {
          listener = nextListener;
          return () => (listener = undefined);
        },
      },
    });
  start();
  const stop = () => exporter.service.stop?.();
  return {
    handler: exporter.handler,
    record(event: EventInput, metadata: DiagnosticEventMetadata = trusted) {
      expectDefined(listener)({ ...baseEvent(), ...event }, metadata, {});
    },
    render: exporter.render,
    start,
    stop,
    [Symbol.dispose]: stop,
  };
}

export const metricsTest = it.extend<{ metrics: ReturnType<typeof createMetricsHarness> }>({
  metrics: async ({ task: _task }, use) => {
    using metrics = createMetricsHarness();
    await use(metrics);
  },
});

export async function withMetricsServer(
  metrics: ReturnType<typeof createMetricsHarness>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  using _ = metrics;
  await using resource = {
    server: createServer((req, res) => void metrics.handler(req, res)),
    async [Symbol.asyncDispose]() {
      if (this.server.listening) {
        await this.server[Symbol.asyncDispose]();
      }
    },
  };
  await once(resource.server.listen(0, "127.0.0.1"), "listening");
  const address = resource.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  await run(`http://127.0.0.1:${address.port}/api/diagnostics/prometheus`);
}
