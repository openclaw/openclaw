import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type DiagnosticEventPayload,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  clearOtelGlobals,
  snapshotOtelEnv,
  getReportedExporterHealth,
  startOtelService,
  type ReportedExporterHealth,
} from "./service.test-helpers.js";

installRealOtelSdkTestHarness();

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const IMMEDIATE_RETRY_AFTER = "Thu, 01 Jan 1970 00:00:00 GMT";
const OTEL_ENV_KEYS = ["OTEL_PROPAGATORS"] as const;

type ExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = snapshotOtelEnv(OTEL_ENV_KEYS);
  clearOtelGlobals();
  for (const key of OTEL_ENV_KEYS) {
    delete process.env[key];
  }
  process.env[PRELOAD_ENV] = "0";
});
afterEach(() => restoreEnv());

async function startExporterHealthReceiver(
  handleRequest: (response: ServerResponse, requestCount: number) => void,
) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    handleRequest(response, requestCount);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function captureExporterEvents() {
  const events: ExporterEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "telemetry.exporter") {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

async function waitForExporterStatus(
  events: Array<Pick<ReportedExporterHealth, "status">>,
  status: ReportedExporterHealth["status"],
) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.status === status)) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for exporter status ${status}`);
}

function emitExporterHealthSpan(name: string) {
  // The global trace API cannot reach the owned private provider.
  emit({
    type: "model.call.completed",
    runId: `run-${name}`,
    callId: `call-${name}`,
    provider: "openai",
    model: "gpt-5.4",
    durationMs: 10,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
}

function startTraceExporterHealthService(endpoint: string, flushIntervalMs?: number) {
  process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "1000";
  return startOtelService({
    endpoint,
    traces: true,
    flushIntervalMs,
  });
}

test("retries a real OTLP 503 then succeeds without an intermediate failure fact", async () => {
  const receiver = await startExporterHealthReceiver((response, requestCount) => {
    response.writeHead(requestCount === 1 ? 503 : 200, {
      ...(requestCount === 1 ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
      "content-type": "application/x-protobuf",
    });
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint);

  try {
    emitExporterHealthSpan("retry-then-success");
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBe(2);
    expect(capture.events.some((event) => event.status === "failure")).toBe(false);
    expect(
      getReportedExporterHealth(ctx).some(
        (event) => event.status === "failure" || event.status === "recovered",
      ),
    ).toBe(false);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test("records one final failure for a non-retryable real OTLP HTTP 400 response", async () => {
  const receiver = await startExporterHealthReceiver((response) => {
    response.writeHead(400);
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint);

  try {
    emitExporterHealthSpan("http-400");
    await waitForDiagnosticEventsDrained();
    await Promise.resolve(service.stop?.(ctx)).catch(() => {});
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBe(1);
    expect(
      capture.events.filter(
        (event) => event.status === "failure" && event.reason === "emit_failed",
      ),
    ).toHaveLength(1);
    expect(
      getReportedExporterHealth(ctx).filter(
        (event) => event.status === "failure" && event.reason === "export_failed",
      ),
    ).toHaveLength(1);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test("records recovery after a later real OTLP export succeeds", async () => {
  let failExports = true;
  const receiver = await startExporterHealthReceiver((response) => {
    response.writeHead(failExports ? 503 : 200, {
      "content-type": "application/x-protobuf",
      ...(failExports ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
    });
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, 1000);
  const health = getReportedExporterHealth(ctx);

  try {
    emitExporterHealthSpan("failure-before-recovery");
    await waitForDiagnosticEventsDrained();
    await waitForExporterStatus(health, "failure");
    failExports = false;
    emitExporterHealthSpan("successful-recovery");
    await waitForDiagnosticEventsDrained();
    await waitForExporterStatus(health, "recovered");
    expect(
      health.filter((event) => event.reason === "export_failed").map((event) => event.status),
    ).toEqual(["failure", "recovered"]);
    expect(capture.events.map((event) => event.status)).not.toContain("recovered");
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);
