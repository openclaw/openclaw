import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

installRealOtelSdkTestHarness();
const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});
type WsEvent = Extract<Parameters<typeof emit>[0], { type: "gateway.ws.event" }>;
const frame = { type: "gateway.ws.event", event: "chat", count: 2, bytes: 256 } as const;
function observeFrames(fields: Omit<WsEvent, "type" | "count" | "bytes">) {
  const observation = { ...frame, ...fields };
  emit(observation);
  emit({ ...observation, count: 1, bytes: 128 });
  emitDiagnosticEvent(observation);
}
const eventAttrs = (event: string, extra: Record<string, string> = {}) => ({
  "openclaw.gateway.ws.event": event,
  ...extra,
});
const eventMetric = (unit: string, values: Record<string, number>) => [
  unit,
  Object.entries(values).map(([event, value]) => [eventAttrs(event), value]),
];
const presencePoints = (value: number) =>
  ["delta", "reset", "legacy"].map((mode) => [{ "openclaw.gateway.ws.mode": mode }, value]);
const sessionPoints = (value: number) =>
  (
    [
      ["sessions.changed", "agent.run.started"],
      ["session.message", "assistant"],
    ] as const
  ).flatMap(([event, reason]) =>
    ["subscribed", "roster"].map((delivery) => [
      eventAttrs(event, {
        "openclaw.gateway.ws.reason": reason,
        "openclaw.gateway.ws.delivery": delivery,
      }),
      value,
    ]),
  );

test("exports trusted WebSocket event totals and the current operator socket count", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ metrics: true });
  emit({ type: "gateway.ws.connections", operators: 2 });
  emit({
    ...frame,
    frameBytes: Object.fromEntries(
      ["256", "512", "1024", "2048", "4096", "8192", "16384", "65536", "+Inf"].map((le) => [le, 2]),
    ),
  });
  emit({ type: "gateway.ws.event", event: "chat", count: 1, bytes: 128 });
  emit({ type: "gateway.ws.event", event: "chat", count: 0, bytes: 0, wireBytes: 100 });
  emit({ type: "gateway.ws.event", event: "chat", count: 0, bytes: 0, wireBytes: 50 });
  emit({ type: "gateway.ws.event", event: "other", count: 1, bytes: 64 });
  emit({ type: "gateway.ws.connections", operators: 0 });
  for (const emitUntrusted of [emitDiagnosticEvent, emitInternalDiagnosticEventForTest]) {
    emitUntrusted({
      type: "gateway.ws.event",
      event: "private-untrusted",
      count: 99,
      bytes: 999,
      wireBytes: 999,
      frameBytes: { "256": 99 },
    });
    emitUntrusted({ type: "gateway.ws.connections", operators: 99 });
  }
  for (const [event, reason] of [
    ["sessions.changed", "agent.run.started"],
    ["session.message", "assistant"],
  ] as const) {
    for (const delivery of ["subscribed", "roster"] as const) {
      observeFrames({ event, sessionEvent: { reason, delivery } });
    }
  }
  for (const presenceMode of ["delta", "reset", "legacy"] as const) {
    observeFrames({ event: "presence", presenceMode });
  }
  await waitForDiagnosticEventsDrained();
  const wsMetrics = await collectTestMetrics(reader, "openclaw.gateway.ws.");
  expect(
    Object.fromEntries(
      wsMetrics.map(({ descriptor: { name, unit }, dataPoints }) => [
        name,
        [unit, dataPoints.map(({ attributes, value }) => [attributes, value])],
      ]),
    ),
  ).toEqual({
    "openclaw.gateway.ws.session_event_frames": ["1", sessionPoints(3)],
    "openclaw.gateway.ws.session_event_bytes": ["By", sessionPoints(384)],
    "openclaw.gateway.ws.presence_frames": ["1", presencePoints(3)],
    "openclaw.gateway.ws.presence_bytes": ["By", presencePoints(384)],
    "openclaw.gateway.ws.events": eventMetric("1", {
      chat: 3,
      other: 1,
      "sessions.changed": 6,
      "session.message": 6,
      presence: 9,
    }),
    "openclaw.gateway.ws.event_bytes": eventMetric("By", {
      chat: 384,
      other: 64,
      "sessions.changed": 768,
      "session.message": 768,
      presence: 1152,
    }),
    "openclaw.gateway.ws.event_wire_bytes": eventMetric("By", { chat: 150 }),
    "openclaw.gateway.ws.event_frame_bytes": [
      "1",
      ["256", "512", "1024", "2048", "4096", "8192", "16384", "65536", "+Inf"].map((le) => [
        eventAttrs("chat", { le }),
        2,
      ]),
    ],
    "openclaw.gateway.ws.operator_connections": ["1", [[{}, 0]]],
  });
});
