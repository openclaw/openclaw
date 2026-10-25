import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { MODEL_CALL_FIXTURE, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

const RESPONSE_MODEL = "z-ai/glm-5.3";
const SECRET_SHAPED_MODEL =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBJKg\n-----END PRIVATE KEY-----";

function spansNamed(spans: ReadableSpan[], name: string) {
  return spans.filter((span) => span.name === name);
}

test("exports the provider-reported response model on model.call spans only", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });

  // Routed call: the preset id was requested, the provider reports the served model.
  emitTrustedDiagnosticEvent({ type: "model.call.started", ...MODEL_CALL_FIXTURE });
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...MODEL_CALL_FIXTURE,
    durationMs: 50,
    responseModel: RESPONSE_MODEL,
  });
  emitTrustedDiagnosticEvent({
    type: "model.call.error",
    ...MODEL_CALL_FIXTURE,
    callId: "call-routed-error",
    durationMs: 60,
    errorCategory: "TimeoutError",
    responseModel: RESPONSE_MODEL,
  });
  // No observed response model: the span must not mint one from the request.
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...MODEL_CALL_FIXTURE,
    callId: "call-unrouted",
    durationMs: 55,
  });
  // Redaction: a secret-shaped response id is redacted exactly like the request id.
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...MODEL_CALL_FIXTURE,
    callId: "call-secret-shaped",
    model: SECRET_SHAPED_MODEL,
    durationMs: 65,
    responseModel: SECRET_SHAPED_MODEL,
  });
  for (const [callId, observationUnit, responseModel] of [
    ["call-turn", "turn", RESPONSE_MODEL],
    ["call-blank", "request", "  "],
  ] as const) {
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      callId,
      observationUnit,
      responseModel,
      durationMs: 5,
    });
  }
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.4",
    channel: "test",
    usage: { input: 3, output: 2, total: 5 },
  });
  await waitForDiagnosticEventsDrained();

  const spans = sdk.exporter.getFinishedSpans();
  const modelCallSpans = spansNamed(spans, "openclaw.model.call");
  expect(modelCallSpans).toHaveLength(6);
  for (const span of modelCallSpans.slice(4)) {
    expect(span.attributes).not.toHaveProperty("gen_ai.response.model");
  }
  // gen_ai.request.model keeps the requested id; gen_ai.response.model carries
  // the provider-reported id on completed and error terminal spans alike.
  expect(modelCallSpans[0]?.attributes).toMatchObject({
    "gen_ai.system": "openai",
    "gen_ai.request.model": "gpt-5.4",
    "gen_ai.response.model": RESPONSE_MODEL,
  });
  expect(modelCallSpans[1]?.attributes).toMatchObject({
    "gen_ai.request.model": "gpt-5.4",
    "gen_ai.response.model": RESPONSE_MODEL,
  });
  expect(modelCallSpans[2]?.attributes).toMatchObject({
    "gen_ai.request.model": "gpt-5.4",
  });
  expect(modelCallSpans[2]?.attributes).not.toHaveProperty("gen_ai.response.model");
  const redactedRequestModel = modelCallSpans[3]?.attributes["gen_ai.request.model"];
  const redactedResponseModel = modelCallSpans[3]?.attributes["gen_ai.response.model"];
  expect(String(redactedRequestModel)).toContain("…redacted…");
  expect(String(redactedRequestModel)).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBJKg");
  expect(redactedResponseModel).toBe(redactedRequestModel);

  // Aggregate usage spans never carry the per-request response model.
  const modelUsageSpans = spansNamed(spans, "openclaw.model.usage");
  expect(modelUsageSpans).toHaveLength(1);
  expect(modelUsageSpans[0]?.attributes).toMatchObject({ "gen_ai.request.model": "gpt-5.4" });
  expect(modelUsageSpans[0]?.attributes).not.toHaveProperty("gen_ai.response.model");

  // Metric labels never carry the response model: unbounded cardinality.
  const { resourceMetrics } = await reader.collect();
  const dataPoints = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .flatMap((metric) =>
      metric.dataPoints.map((point) => ({
        name: metric.descriptor.name,
        attributes: point.attributes,
      })),
    )
    .filter((point) =>
      [
        "openclaw.model_call.duration_ms",
        "gen_ai.client.operation.duration",
        "gen_ai.client.token.usage",
        "openclaw.tokens",
      ].includes(point.name),
    );
  expect(dataPoints).not.toHaveLength(0);
  for (const { attributes } of dataPoints) {
    expect(attributes).not.toHaveProperty("gen_ai.response.model");
  }
});
