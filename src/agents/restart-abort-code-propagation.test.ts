import { failTransportStream, finalizeTransportStream } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantOutput,
  makeCompletionsModel,
} from "./openai-transport-stream.test-harness.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

/** Exercise coded cancellation through the real transport terminal assembly. */
function runTerminalTransportTurn(signal: AbortSignal) {
  const model = makeCompletionsModel({
    id: "restart-abort-probe",
    name: "Restart Abort Probe",
    provider: "local",
    baseUrl: "http://127.0.0.1:18099/v1",
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
  });
  const output = createAssistantOutput(model);
  // Mirrors the try/catch every transport wraps its stream in
  // (openai-completions-transport.ts): finalize throws for an aborted signal
  // and the catch turns that error into the persisted terminal message.
  try {
    finalizeTransportStream({
      stream: { push: vi.fn(), end: vi.fn() },
      output,
      signal,
    });
  } catch (error) {
    failTransportStream({ stream: { push: vi.fn(), end: vi.fn() }, output, signal, error });
  }
  return output;
}

describe("restart abort code propagation", () => {
  it("preserves the gateway restart code on the transport terminal", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    const message = runTerminalTransportTurn(controller.signal);
    expect(message.errorCode).toBe("OPENCLAW_RESTART_ABORT");
  });

  it("preserves a timeout code without relabeling it as a restart", () => {
    const controller = new AbortController();
    const timeout = Object.assign(new Error("First stream event timed out"), {
      name: "TimeoutError",
      code: "OPENCLAW_FIRST_EVENT_TIMEOUT",
    });
    controller.abort(timeout);

    const message = runTerminalTransportTurn(controller.signal);
    expect(message.errorCode).toBe("OPENCLAW_FIRST_EVENT_TIMEOUT");
  });
});
