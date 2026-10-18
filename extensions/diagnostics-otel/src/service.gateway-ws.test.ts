import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

test("exports trusted WebSocket event totals and the current operator socket count", async () => {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  const { service, ctx } = await startOtelService({ metrics: true });
  try {
    emit({ type: "gateway.ws.connections", operators: 2 });
    emit({ type: "gateway.ws.event", event: "chat", count: 2, bytes: 256 });
    emit({ type: "gateway.ws.event", event: "chat", count: 1, bytes: 128 });
    emit({ type: "gateway.ws.event", event: "other", count: 1, bytes: 64 });
    emit({ type: "gateway.ws.connections", operators: 0 });
    for (const emitUntrusted of [emitDiagnosticEvent, emitInternalDiagnosticEventForTest]) {
      emitUntrusted({
        type: "gateway.ws.event",
        event: "private-untrusted",
        count: 99,
        bytes: 999,
      });
      emitUntrusted({ type: "gateway.ws.connections", operators: 99 });
    }
    for (const [event, reason] of [
      ["sessions.changed", "agent.run.started"],
      ["session.message", "assistant"],
    ] as const) {
      for (const delivery of ["subscribed", "roster"] as const) {
        const observation = {
          type: "gateway.ws.event",
          event,
          count: 2,
          bytes: 256,
          sessionEvent: { reason, delivery },
        } as const;
        emit(observation);
        emit({ ...observation, count: 1, bytes: 128 });
        emitDiagnosticEvent(observation);
      }
    }
    for (const presenceMode of ["delta", "reset", "legacy"] as const) {
      const observation = {
        type: "gateway.ws.event",
        event: "presence",
        count: 2,
        bytes: 256,
        presenceMode,
      } as const;
      emit(observation);
      emit({ ...observation, count: 1, bytes: 128 });
      emitDiagnosticEvent(observation);
    }
    await waitForDiagnosticEventsDrained();

    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const wsMetrics = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name.startsWith("openclaw.gateway.ws."));
    expect(
      Object.fromEntries(
        wsMetrics.map((metric) => [
          metric.descriptor.name,
          {
            unit: metric.descriptor.unit,
            points: metric.dataPoints.map(({ attributes, value }) => ({ attributes, value })),
          },
        ]),
      ),
    ).toEqual({
      ...Object.fromEntries(
        [
          ["openclaw.gateway.ws.session_event_frames", "1", 3],
          ["openclaw.gateway.ws.session_event_bytes", "By", 384],
        ].map(([name, unit, value]) => [
          name,
          {
            unit,
            points: [
              ["sessions.changed", "agent.run.started"],
              ["session.message", "assistant"],
            ].flatMap(([event, reason]) =>
              ["subscribed", "roster"].map((delivery) => ({
                attributes: {
                  "openclaw.gateway.ws.event": event,
                  "openclaw.gateway.ws.reason": reason,
                  "openclaw.gateway.ws.delivery": delivery,
                },
                value,
              })),
            ),
          },
        ]),
      ),
      ...Object.fromEntries(
        [
          ["openclaw.gateway.ws.presence_frames", "1", 3],
          ["openclaw.gateway.ws.presence_bytes", "By", 384],
        ].map(([name, unit, value]) => [
          name,
          {
            unit,
            points: ["delta", "reset", "legacy"].map((mode) => ({
              attributes: { "openclaw.gateway.ws.mode": mode },
              value,
            })),
          },
        ]),
      ),
      "openclaw.gateway.ws.events": {
        unit: "1",
        points: [
          { attributes: { "openclaw.gateway.ws.event": "chat" }, value: 3 },
          { attributes: { "openclaw.gateway.ws.event": "other" }, value: 1 },
          { attributes: { "openclaw.gateway.ws.event": "sessions.changed" }, value: 6 },
          { attributes: { "openclaw.gateway.ws.event": "session.message" }, value: 6 },
          { attributes: { "openclaw.gateway.ws.event": "presence" }, value: 9 },
        ],
      },
      "openclaw.gateway.ws.event_bytes": {
        unit: "By",
        points: [
          { attributes: { "openclaw.gateway.ws.event": "chat" }, value: 384 },
          { attributes: { "openclaw.gateway.ws.event": "other" }, value: 64 },
          { attributes: { "openclaw.gateway.ws.event": "sessions.changed" }, value: 768 },
          { attributes: { "openclaw.gateway.ws.event": "session.message" }, value: 768 },
          { attributes: { "openclaw.gateway.ws.event": "presence" }, value: 1152 },
        ],
      },
      "openclaw.gateway.ws.operator_connections": {
        unit: "1",
        points: [{ attributes: {}, value: 0 }],
      },
    });
  } finally {
    await service.stop?.(ctx);
    await meterProvider.shutdown();
  }
});
