import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { DiagnosticEventPrivateData } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { expect } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginHttpRouteHandler,
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

export function baseEvent(): Pick<DiagnosticEventPayload, "seq" | "ts"> {
  return { seq: 1, ts: 1700000000000 };
}

export function scrapeMetrics(handler: OpenClawPluginHttpRouteHandler): string {
  const response = createMockServerResponse();
  response.flushHeaders = () => {};
  response.req.method = "GET";
  response.req.url = "/api/diagnostics/prometheus";
  expect(handler(response.req, response)).toBe(true);
  expect(response.statusCode).toBe(200);
  expect(response.headersSent).toBe(true);
  return response.body?.toString() ?? "";
}

export function createMetricsHarness(
  getRuntimeIdentity?: NonNullable<
    OpenClawPluginServiceContext["internalDiagnostics"]
  >["getRuntimeIdentity"],
  config: OpenClawPluginServiceContext["config"] = {},
  onGatewayWorkMetrics?: TrustedExporterInternalDiagnostics["onGatewayWorkMetrics"],
) {
  const exporter = createDiagnosticsPrometheusExporter();
  let listener:
    | ((
        event: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => void)
    | undefined;
  let workerListener:
    | Parameters<NonNullable<TrustedExporterInternalDiagnostics["onWorkerRequestMetrics"]>>[0]
    | undefined;
  const internalDiagnostics: TrustedExporterInternalDiagnostics = {
    ...(getRuntimeIdentity ? { getRuntimeIdentity } : {}),
    ...(onGatewayWorkMetrics ? { onGatewayWorkMetrics } : {}),
    emit() {},
    onWorkerRequestMetrics(nextListener) {
      workerListener = nextListener;
      return () => {
        workerListener = undefined;
      };
    },
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    reportExporterHealth() {},
  };
  const context: OpenClawPluginServiceContext = {
    config,
    stateDir: "/tmp/openclaw-prometheus-test",
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    internalDiagnostics,
  };
  const start = () => exporter.service.start(context);
  start();
  const stop = () => exporter.service.stop?.();
  return {
    handler: exporter.handler,
    logger: context.logger,
    record(event: EventInput, metadata: DiagnosticEventMetadata = trusted) {
      if (event.type === "worker.request" && metadata.trusted) {
        expectDefined(workerListener, "Worker metrics listener")(
          event.kind,
          event.requestClass,
          event.phase,
          event.queueDepth,
          event.queueWaitMs,
          event.durationMs,
          event.timing,
        );
        return;
      }
      expectDefined(listener, "Prometheus diagnostics listener")(
        { ...baseEvent(), ...event },
        metadata,
        {},
      );
    },
    render: () => scrapeMetrics(exporter.handler),
    start,
    stop,
    [Symbol.dispose]: stop,
  };
}

export function expectRecordedMetrics(
  events: readonly EventInput[],
  samples: string,
  excluded: readonly string[] = [],
) {
  using metrics = createMetricsHarness();
  for (const event of events) {
    metrics.record(event);
  }
  const rendered = metrics.render();
  expectMetrics(rendered)(samples);
  expectExcludes(rendered, ...excluded);
}

export async function withMetricsServer(
  metrics: ReturnType<typeof createMetricsHarness>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    void metrics.handler(req, res);
  });
  try {
    const port = await listenOnLoopback(server);
    await run(`http://127.0.0.1:${port}/api/diagnostics/prometheus`);
  } finally {
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      }
    } finally {
      metrics.stop();
    }
  }
}
