import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
const originKey = "openclaw.origin.channel.id";
const origin = { messageOrigin: { channelId: "C012Example" } };
const run = { runId: "run-origin", provider: "example", model: "example", channel: "slack" };

test.each([
  { captureMessageOrigin: false, captureContent: false, expected: undefined },
  { captureMessageOrigin: false, captureContent: true, expected: undefined },
  { captureMessageOrigin: true, captureContent: false, expected: "C012Example" },
])(
  "gates origin separately from content: $captureMessageOrigin / $captureContent",
  async (flags) => {
    const { reader } = installTestMeter();
    await startOtelService({
      traces: true,
      metrics: true,
      configure: (ctx) => {
        Object.assign(ctx.config.diagnostics!.otel!, {
          captureMessageOrigin: flags.captureMessageOrigin,
          captureContent: flags.captureContent,
        });
      },
    });
    const trace = createDiagnosticTraceContext();
    emitTrustedDiagnosticEventWithPrivateData({ type: "run.started", ...run, trace }, origin);
    emitTrustedDiagnosticEventWithPrivateData(
      { type: "run.completed", ...run, trace, outcome: "completed", durationMs: 10 },
      origin,
    );
    const messageTrace = createDiagnosticTraceContext();
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "message.dispatch.started",
        channel: "slack",
        source: "dispatch",
        trace: messageTrace,
      },
      {},
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "message.processed",
        channel: "slack",
        trace: messageTrace,
        outcome: "completed",
        durationMs: 10,
      },
      origin,
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        ...run,
        callId: "call-origin",
        trace: createChildDiagnosticTraceContext(trace),
        durationMs: 10,
      },
      origin,
    );
    await waitForDiagnosticEventsDrained();
    await sdk.provider.forceFlush();
    const spans = sdk.exporter.getFinishedSpans();
    expect(spans.find((span) => span.name === "openclaw.run")?.attributes[originKey]).toBe(
      flags.expected,
    );
    expect(
      spans.find((span) => span.name === "openclaw.message.processed")?.attributes[originKey],
    ).toBe(flags.expected);
    expect(
      spans.find((span) => span.name === "openclaw.model.call")?.attributes[originKey],
    ).toBeUndefined();
    for (const metric of await collectTestMetrics(reader)) {
      for (const point of metric.dataPoints) {
        expect(point.attributes).not.toHaveProperty(originKey);
        expect(Object.values(point.attributes)).not.toContain(origin.messageOrigin.channelId);
      }
    }
  },
);

test("retains start origin and records completion-only spans without content", async () => {
  const { service, ctx } = await startOtelService({
    traces: true,
    configure: (context) => {
      context.config.diagnostics!.otel!.captureMessageOrigin = true;
    },
  });
  const trace = createDiagnosticTraceContext();
  emitTrustedDiagnosticEventWithPrivateData({ type: "run.started", ...run, trace }, origin);
  emitTrustedDiagnosticEventWithPrivateData(
    { type: "run.completed", ...run, outcome: "error", durationMs: 10 },
    { messageOrigin: { channelId: "D012Example" } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);
  const spans = sdk.exporter.getFinishedSpans().filter((span) => span.name === "openclaw.run");
  expect(spans.map((span) => span.attributes[originKey]).toSorted()).toEqual([
    "C012Example",
    "D012Example",
  ]);
  for (const span of spans) {
    expect(span.attributes).not.toHaveProperty("input.value");
    expect(span.attributes).not.toHaveProperty("output.value");
  }
});

test.each(["", "C012 bad", "C012\nexample", "A".repeat(129)])(
  "omits unsuitable origin identifiers",
  async (channelId) => {
    await startOtelService({
      traces: true,
      configure: (context) => {
        context.config.diagnostics!.otel!.captureMessageOrigin = true;
      },
    });
    emitTrustedDiagnosticEventWithPrivateData(
      { type: "run.completed", ...run, outcome: "completed", durationMs: 10 },
      { messageOrigin: { channelId } },
    );
    await waitForDiagnosticEventsDrained();
    const span = sdk.exporter.getFinishedSpans().find((item) => item.name === "openclaw.run");
    expect(span?.attributes).not.toHaveProperty(originKey);
  },
);
