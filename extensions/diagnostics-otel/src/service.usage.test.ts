import {
  emitTrustedDiagnosticEvent,
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

test.each(["available", "unavailable"] as const)(
  "preserves %s auxiliary accounting without inventing token observations",
  async (state) => {
    const { reader } = installTestMeter();
    await startOtelService({ traces: true, metrics: true });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      provider: "fixture",
      model: "fixture-model",
      purpose: "session-activity-summary",
      usageReport: { state },
      usage: state === "available" ? { input: 0, output: 0, total: 0 } : {},
      durationMs: 25,
    });
    await waitForDiagnosticEventsDrained();
    const spans = sdk.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "openclaw.model.usage");
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    expect.soft(attrs).toMatchObject({ "openclaw.usage.state": state });
    if (state === "available") {
      expect(attrs).toMatchObject({
        "openclaw.tokens.input": 0,
        "openclaw.tokens.output": 0,
        "openclaw.tokens.total": 0,
      });
    } else {
      expect(
        Object.keys(attrs).filter(
          (key) => key.startsWith("openclaw.tokens.") || key.startsWith("gen_ai.usage."),
        ),
      ).toEqual([]);
    }
    const metrics = await collectTestMetrics(reader, "openclaw.");
    expect(metrics.find((metric) => metric.descriptor.name === "openclaw.tokens")).toBeUndefined();
    expect(
      metrics.find((metric) => metric.descriptor.name === "openclaw.cost.usd"),
    ).toBeUndefined();
    expect(
      metrics.find((metric) => metric.descriptor.name === "openclaw.run.duration_ms")?.dataPoints,
    ).toMatchObject([{ value: { count: 1, sum: 25 } }]);
  },
);

test("records cached prompt tokens in GenAI input token usage like the usage span", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "fixture",
    model: "fixture-model",
    usage: { input: 2_000, output: 50, cacheRead: 50_000, promptTokens: 52_000, total: 52_050 },
  });
  await waitForDiagnosticEventsDrained();
  const span = sdk.exporter.getFinishedSpans().find((s) => s.name === "openclaw.model.usage");
  expect(span?.attributes["gen_ai.usage.input_tokens"]).toBe(52_000);
  const [metric] = await collectTestMetrics(reader, "gen_ai.client.token.usage");
  const sumFor = (type: string) =>
    metric?.dataPoints.find((point) => point.attributes["gen_ai.token.type"] === type)?.value;
  expect([sumFor("input"), sumFor("output")]).toMatchObject([{ sum: 52_000 }, { sum: 50 }]);
});
