import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { AssistantMessage, Model } from "../llm/types.js";

const completeSimple = vi.hoisted(() => vi.fn());
// mock-isolation: Supply deterministic provider outcomes without registering live transports.
vi.mock("../llm/stream.js", () => ({ completeSimple }));
// mock-isolation: Provider runtime bootstrap is outside this request-lifecycle boundary.
vi.mock("./ai-transport-runtime-host.js", () => ({}));
import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 128,
};
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "title" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 8,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0.000008, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.00001 },
  },
};

beforeEach(() => {
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(true);
  completeSimple.mockReset();
});
afterEach(() => resetDiagnosticEventsForTest());

describe("prepared background completion diagnostics", () => {
  it.each(["success", "returned-error", "throw"] as const)(
    "records exactly one request lifecycle for %s without recording usage twice",
    async (outcome) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onTrustedInternalDiagnosticEvent((event) => {
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
      try {
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
        expect(calls[0]).toMatchObject({
          provider: "test",
          model: "test-model",
          observationUnit: "request",
        });
        expect(calls[1]).toMatchObject({
          callId: calls[0]?.callId,
          durationMs: expect.any(Number),
        });
        expect(events.filter((event) => event.type === "model.usage")).toEqual([]);
        expect(completeSimple).toHaveBeenCalledOnce();
      } finally {
        stop();
      }
    },
  );
});
