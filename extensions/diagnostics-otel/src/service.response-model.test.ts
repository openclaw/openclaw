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
import { MODEL_CALL_FIXTURE, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
const RESPONSE_MODEL = "z-ai/glm-5.3";
const SECRET_SHAPED_MODEL =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBJKg\n-----END PRIVATE KEY-----";
type ModelEvent = Extract<
  Parameters<typeof emitTrustedDiagnosticEvent>[0],
  { type: "model.call.completed" }
>;
function finishCall(overrides: Partial<ModelEvent> = {}) {
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...MODEL_CALL_FIXTURE,
    durationMs: 50,
    ...overrides,
  });
}

test("exports the provider-reported response model on model.call spans only", async () => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });
  emitTrustedDiagnosticEvent({ type: "model.call.started", ...MODEL_CALL_FIXTURE });
  finishCall({ responseModel: RESPONSE_MODEL });
  emitTrustedDiagnosticEvent({
    type: "model.call.error",
    ...MODEL_CALL_FIXTURE,
    durationMs: 60,
    callId: "call-routed-error",
    errorCategory: "TimeoutError",
    responseModel: RESPONSE_MODEL,
  });
  finishCall({ callId: "call-unrouted" });
  finishCall({
    callId: "call-secret-shaped",
    model: SECRET_SHAPED_MODEL,
    responseModel: SECRET_SHAPED_MODEL,
  });
  finishCall({ callId: "call-turn", observationUnit: "turn", responseModel: RESPONSE_MODEL });
  finishCall({ callId: "call-blank", responseModel: "  " });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.4",
    channel: "test",
    usage: { input: 3, output: 2, total: 5 },
  });
  await waitForDiagnosticEventsDrained();

  const spansNamed = (name: string) =>
    sdk.exporter.getFinishedSpans().filter((span) => span.name === name);
  const calls = spansNamed("openclaw.model.call");
  expect(calls).toHaveLength(6);
  for (const span of calls.slice(0, 2)) {
    expect(span.attributes).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.response.model": RESPONSE_MODEL,
    });
  }
  expect(calls[2]?.attributes).toMatchObject({ "gen_ai.request.model": "gpt-5.4" });
  for (const index of [2, 4, 5]) {
    expect(calls[index]?.attributes).not.toHaveProperty("gen_ai.response.model");
  }
  const redactedRequest = calls[3]?.attributes["gen_ai.request.model"];
  expect(String(redactedRequest)).toContain("…redacted…");
  expect(String(redactedRequest)).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBJKg");
  expect(calls[3]?.attributes["gen_ai.response.model"]).toBe(redactedRequest);

  const usage = spansNamed("openclaw.model.usage");
  expect(usage).toHaveLength(1);
  expect(usage[0]?.attributes).toMatchObject({ "gen_ai.request.model": "gpt-5.4" });
  expect(usage[0]?.attributes).not.toHaveProperty("gen_ai.response.model");

  const metrics = await collectTestMetrics(reader);
  expect(metrics.some((metric) => metric.dataPoints.length > 0)).toBe(true);
  for (const metric of metrics) {
    for (const { attributes } of metric.dataPoints) {
      expect(attributes).not.toHaveProperty("gen_ai.response.model");
    }
  }
});
