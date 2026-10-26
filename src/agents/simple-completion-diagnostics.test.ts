import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { activityByRunId } from "../logging/diagnostic-run-activity-state.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import {
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../logging/diagnostic-stability.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const completeSimple = vi.hoisted(() => vi.fn());
// mock-isolation: Supply deterministic provider outcomes without registering live transports.
vi.mock("../llm/stream.js", () => ({ completeSimple }));
// mock-isolation: Provider runtime bootstrap is outside this request-lifecycle boundary.
vi.mock("./ai-transport-runtime-host.js", () => ({}));
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

const model = makeProviderModelFixture({
  id: "test-model",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
});
const assistant = makeAssistantMessageFixture({
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text: "title" }],
  stopReason: "stop",
  errorMessage: undefined,
  timestamp: 1,
  usage: {
    input: 8,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0.000008, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.00001 },
  },
});
let stop: (() => void) | undefined;
beforeEach(() => {
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(true);
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
  completeSimple.mockReset();
});
afterEach(() => {
  stopDiagnosticStabilityRecorder();
  stop?.();
  stop = undefined;
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

it("does not serialize prompts for the default activity and stability listeners", async () => {
  startDiagnosticStabilityRecorder();
  completeSimple.mockResolvedValue(assistant);
  const messages = [{ role: "user" as const, content: "Generate a title", timestamp: 1 }];
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    for (let call = 0; call < 3; call++) {
      await completeWithPreparedSimpleCompletionModel({
        model,
        auth: { apiKey: "synthetic", source: "test", mode: "api-key" },
        context: { messages },
      });
    }
    await waitForDiagnosticEventsDrained();
    expect(stringify.mock.calls.filter(([value]) => value === messages)).toHaveLength(0);
    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(activityByRunId.size).toBe(0);
  } finally {
    stringify.mockRestore();
  }
});

it.each(["success", "returned-error", "throw"] as const)(
  "records one %s request lifecycle without duplicate usage",
  async (outcome) => {
    const events: DiagnosticEventPayload[] = [];
    stop = onTrustedInternalDiagnosticEvent((event) => {
      events.push(event);
    });
    const error = new Error("provider unavailable");
    if (outcome === "throw") {
      completeSimple.mockRejectedValue(error);
    } else {
      completeSimple.mockResolvedValue(
        outcome === "success"
          ? assistant
          : {
              ...assistant,
              stopReason: "error",
              errorMessage: error.message,
            },
      );
    }
    const pending = completeWithPreparedSimpleCompletionModel({
      model,
      auth: { apiKey: "synthetic", source: "test", mode: "api-key" },
      context: { messages: [{ role: "user", content: "Generate a title", timestamp: 1 }] },
    });
    if (outcome === "throw") {
      await expect(pending).rejects.toBe(error);
    } else {
      await expect(pending).resolves.toMatchObject({ role: "assistant" });
    }
    await waitForDiagnosticEventsDrained();
    const calls = events.filter(
      (event) =>
        event.type === "model.call.started" ||
        event.type === "model.call.completed" ||
        event.type === "model.call.error",
    );
    expect(calls.map((event) => event.type)).toEqual([
      "model.call.started",
      outcome === "success" ? "model.call.completed" : "model.call.error",
    ]);
    expect(calls).toMatchObject([
      { provider: "test", model: "test-model", observationUnit: "request" },
      { callId: calls[0]?.callId, durationMs: expect.any(Number) },
    ]);
    expect(events.filter((event) => event.type === "model.usage")).toEqual([]);
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(activityByRunId.size).toBe(0);
  },
);
