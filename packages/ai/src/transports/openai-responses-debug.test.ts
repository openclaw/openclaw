import { afterEach, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  normalizeResponsesFailedEvent as normalizeFailure,
  observeResponsesTransportFailure as observeFailure,
  ResponsesStreamFailure,
  summarizeResponsesPayload as summarizePayload,
} from "./openai-responses-debug.js";
import { createAssistant, createModel } from "./openai-responses-prompt-observer.test-support.js";

const initialHost = getAiTransportHost();
const failedEventModel = createModel({ id: "gpt-5.6-luna" });
const failedResponse = (error: { message: string; code?: string }) =>
  normalizeFailure({ response: { id: "resp_failed", status: "failed", error } }, failedEventModel);
const privateText = "synthetic private prompt and tool result";
const ciphertext = "opaque-private-ciphertext";
const compaction = { type: "compaction", id: "cmp-private-id", encrypted_content: ciphertext };
function expectRedacted(value: string) {
  expect(value).not.toContain(privateText);
  expect(value).not.toContain(ciphertext);
  expect(value).not.toContain(compaction.id);
}

function observeTransportWarning(error: unknown, requestSignal?: AbortSignal): string {
  const logWarn = vi.fn();
  configureAiTransportHost({ ...initialHost, isLogEnabled: () => true, logWarn });
  expect(
    observeFailure({
      error,
      model: failedEventModel,
      output: createAssistant(failedEventModel),
      signal: AbortSignal.abort(new Error("synthetic outer transport failure")),
      requestSignal,
    }),
  ).toBeUndefined();
  expect(logWarn).toHaveBeenCalledExactlyOnceWith(
    "openai-transport",
    expect.stringContaining("[responses] error provider=openai"),
    undefined,
  );
  return logWarn.mock.calls[0]?.[1] ?? "";
}

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.unstubAllEnvs();
});

it.each(["summary", "tools", "full-redacted"])(
  "redacts %s prompt, tool and provider-error content",
  (mode) => {
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", mode);
    const summary = summarizePayload({
      apiKey: privateText,
      instructions: privateText,
      input: [
        { type: "message", role: "user", content: privateText },
        { type: "function_call", name: "exec", arguments: privateText },
        { type: "function_call_output", output: privateText },
        compaction,
      ],
      tools: [
        { type: "function", name: "exec", description: privateText },
        { type: "function", function: { name: "wait" } },
        { type: "web_search" },
        { type: "function" },
      ],
    });
    expectRedacted(summary);
    expect(summary).toMatch(/compactionIdHashes=[a-f0-9]{64}/u);
    expect(summary).toMatch(/compactionPayloadHashes=[a-f0-9]{64}/u);
    const failure = normalizeFailure(
      { response: { error_details: { text: privateText, input: [compaction] } } },
      failedEventModel,
    );
    expect(failure.observation?.failureFieldNames).toEqual(["error_details"]);
    expectRedacted(JSON.stringify(failure.observation));
    const error = Object.assign(new Error(privateText), {
      status: 503,
      code: "service_unavailable",
      cause: Object.assign(new Error(privateText), { code: "ECONNRESET" }),
    });
    const warning = observeTransportWarning(error);
    expectRedacted(warning);
    expect(warning).toContain("causeCode=ECONNRESET");
    for (const value of [
      privateText,
      { message: privateText },
      {
        code: { output: privateText },
        type: privateText,
        cause: { name: privateText, code: { tool_arguments: privateText } },
      },
    ]) {
      expectRedacted(observeTransportWarning(value));
    }
    const controller = new AbortController();
    controller.abort(new Error(privateText));
    const abortedWarning = observeTransportWarning(error, controller.signal);
    expect(abortedWarning).toContain("abortReason=caller_abort");
    expectRedacted(abortedWarning);
  },
);

it.each([
  [{ name: "LlmIdleTimeoutError" }, "idle_timeout"],
  [{ name: "LlmNoProgressError" }, "no_progress"],
  [{ name: "FirstStreamEventTimeoutError" }, "first_event_timeout"],
  [new DOMException("private timeout text", "TimeoutError"), "request_deadline"],
  [{ code: "OPENCLAW_SESSION_WATCHDOG" }, "session_watchdog"],
  [{ code: "OPENCLAW_RESTART_ABORT" }, "restart"],
  [{ code: "ERR_STALE_GATEWAY_LIFECYCLE" }, "restart"],
  [{ code: "AGENT_RUN_SUPERSEDED_ABORT" }, "superseded"],
  [{ code: "OPENCLAW_DIRECT_ABORT" }, "caller_abort"],
  ["private caller text", "caller_abort"],
])("classifies %j as %s without exposing reason text", (reason, expected) => {
  const controller = new AbortController();
  const error = new Error("private provider text");
  expect(
    observeFailure({
      error,
      model: failedEventModel,
      output: createAssistant(failedEventModel),
      requestSignal: controller.signal,
    }),
  ).toEqual({ abortReason: undefined, incompleteReason: undefined });
  controller.abort(reason);
  const diagnostic = observeFailure({
    error,
    model: failedEventModel,
    output: createAssistant(failedEventModel),
    requestSignal: controller.signal,
  });
  expect(diagnostic).toEqual({ abortReason: expected, incompleteReason: undefined });
  expect(JSON.stringify(diagnostic)).not.toContain("private");
});

it("reports an empty replay set for non-array input", () => {
  expect(summarizePayload({ input: "hello" })).toContain(
    "compactionItems=0 compactionIdHashes=none compactionPayloadHashes=none compactionInputIndexes=none",
  );
});
it.each(["server_error", undefined])("preserves %s for failover (#117609)", (code) => {
  const summary = failedResponse({ code, message: "provider failed" });
  const expected = {
    message: `${code ?? "unknown"}: provider failed`,
    responseId: "resp_failed",
  };
  expect(summary.code).toBe(code);
  expect(summary).toMatchObject(expected);

  const failure = new ResponsesStreamFailure(summary, undefined);
  expect(failure.code).toBe(code);
  expect(failure).toMatchObject(expected);
});
