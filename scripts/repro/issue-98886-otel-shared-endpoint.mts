// Reproduction for issue #98886: shared OTLP endpoint signal-qualified routing.
//
// Runs a real loopback OTLP/HTTP receiver and drives the production
// diagnostics-otel service so traces, metrics, and logs each POST to their own
// path when the shared endpoint ends in `/v1/traces`.
//
// Usage: node --import tsx scripts/repro/issue-98886-otel-shared-endpoint.mts

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDiagnosticsOtelService } from "../../extensions/diagnostics-otel/runtime-api.js";
import { onTrustedInternalDiagnosticEvent } from "../../src/infra/diagnostic-events.js";

const SHARED_ENDPOINT_PATH = "/v1/traces";
const REQUEST_TIMEOUT_MS = 10_000;
const FLUSH_WAIT_MS = 6000;

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-repro-98886-"));
  await mkdir(tmpDir, { recursive: true });

  const receivedPaths: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    receivedPaths.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });

  const startServer = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("server start timed out")),
      REQUEST_TIMEOUT_MS,
    );
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timeout);
      const address = server.address();
      resolve(typeof address === "object" && address != null ? address.port : 0);
    });
  });

  let port: number;
  try {
    port = await startServer;
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const endpoint = `http://127.0.0.1:${port}${SHARED_ENDPOINT_PATH}`;
  const previousEnv = new Map<string, string | undefined>();
  const envToClear = [
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_SERVICE_NAME",
  ] as const;

  for (const key of envToClear) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.OTEL_SERVICE_NAME = "openclaw-repro-98886";

  const service = createDiagnosticsOtelService();
  const context = {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint,
          protocol: "http/protobuf",
          traces: true,
          metrics: true,
          logs: true,
          flushIntervalMs: 1000,
        },
      },
    },
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEventWithPrivateData,
      onEvent: onTrustedInternalDiagnosticEvent,
    },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    stateDir: tmpDir,
  };

  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const harnessTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  });
  const runTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "1111111111111111",
    parentSpanId: harnessTrace.spanId,
    traceFlags: "01",
  });
  const modelTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "2222222222222222",
    parentSpanId: runTrace.spanId,
    traceFlags: "01",
  });
  const runId = `repro-98886-${randomUUID().slice(0, 8)}`;

  let failed = false;
  try {
    await service.start(context);

    emitTrustedDiagnosticEvent({
      type: "harness.run.started",
      runId,
      harnessId: "repro-98886",
      pluginId: "diagnostics-otel",
      provider: "openai",
      model: "gpt-5.5",
      channel: "repro",
      trace: harnessTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId,
      provider: "openai",
      model: "gpt-5.5",
      channel: "repro",
      trace: runTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId,
      callId: `${runId}-call`,
      provider: "openai",
      model: "gpt-5.5",
      api: "responses",
      transport: "direct",
      trace: modelTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "log.record",
      level: "info",
      message: "repro 98886 log line",
      loggerName: "repro-98886",
      trace: runTrace,
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        runId,
        callId: `${runId}-call`,
        provider: "openai",
        model: "gpt-5.5",
        api: "responses",
        transport: "direct",
        durationMs: 1,
        usage: { input: 1, output: 1, total: 2 },
        trace: modelTrace,
      },
      {},
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        runId,
        provider: "openai",
        model: "gpt-5.5",
        channel: "repro",
        durationMs: 1,
        outcome: "success",
        trace: runTrace,
      },
      {},
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.completed",
        runId,
        harnessId: "repro-98886",
        pluginId: "diagnostics-otel",
        provider: "openai",
        model: "gpt-5.5",
        channel: "repro",
        durationMs: 2,
        outcome: "success",
        trace: harnessTrace,
      },
      {},
    );

    await waitForDiagnosticEventsDrained();
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), FLUSH_WAIT_MS);
    });

    const uniquePaths = [...new Set(receivedPaths)];
    console.log("Shared endpoint:", endpoint);
    console.log("Received OTLP POST paths:", uniquePaths);

    const hasTraces = uniquePaths.includes("/v1/traces");
    const hasMetrics = uniquePaths.includes("/v1/metrics");
    const hasLogs = uniquePaths.includes("/v1/logs");

    if (!hasTraces || !hasMetrics || !hasLogs) {
      console.error(
        `FAIL: Expected requests on /v1/traces, /v1/metrics, and /v1/logs, but got: ${JSON.stringify(uniquePaths)}`,
      );
      failed = true;
    } else {
      console.log("PASS: traces, metrics, and logs each routed to their own OTLP path.");
    }
  } finally {
    await service.stop?.(context);
    server.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
