import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeResponsesFailedEvent as normalizeFailure,
  ResponsesStreamFailure,
  summarizeResponsesPayload as summarizePayload,
  summarizeOpenAITransportError as summarizeError,
} from "./openai-responses-debug.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";

const failedEventModel = createModel({ id: "gpt-5.6-luna" });
const failedResponse = (error: { message: string; code?: string }) =>
  normalizeFailure({ response: { id: "resp_failed", status: "failed", error } }, failedEventModel);
const privateText = "synthetic private prompt and tool result";
function expectRedacted(value: string, ...visible: string[]) {
  for (const part of visible) {
    expect(value).toContain(part);
  }
  expect(value).not.toContain(privateText);
}

describe("OpenAI Responses diagnostics", () => {
  afterEach(() => vi.unstubAllEnvs());

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
          {
            type: "compaction",
            id: "cmp-private-id",
            encrypted_content: "opaque-private-ciphertext",
          },
        ],
        tools: [
          { type: "function", name: "exec", description: privateText },
          { type: "function", function: { name: "wait" } },
          { type: "web_search" },
          { type: "function" },
        ],
      });
      expectRedacted(summary, "tools=count=4 names=exec,wait,web_search", "inputItems=4");
      expect(summary).toContain("compactionItems=1");
      expect(summary).toContain("compactionInputIndexes=3");
      expect(summary).toContain(
        "inputItemShape=message:user,function_call,function_call_output,compaction",
      );
      expect(summary).toMatch(/compactionIdHashes=[a-f0-9]{64}/u);
      expect(summary).toMatch(/compactionPayloadHashes=[a-f0-9]{64}/u);
      expect(summary).not.toContain("cmp-private-id");
      expect(summary).not.toContain("opaque-private-ciphertext");
      const failure = normalizeFailure(
        { response: { error_details: { text: privateText } } },
        failedEventModel,
      );
      expect(failure.observation?.failureFieldNames).toEqual(["error_details"]);
      expectRedacted(JSON.stringify(failure.observation));
      const error = Object.assign(new Error(privateText), {
        status: 503,
        code: "service_unavailable",
        cause: Object.assign(new Error(privateText), { code: "ECONNRESET" }),
      });
      expectRedacted(
        summarizeError(error),
        "status=503 code=service_unavailable",
        "causeCode=ECONNRESET",
      );
      for (const value of [
        privateText,
        { message: privateText },
        {
          code: { output: privateText },
          type: privateText,
          cause: { name: privateText, code: { tool_arguments: privateText } },
        },
      ]) {
        expectRedacted(summarizeError(value));
      }
      const controller = new AbortController();
      controller.abort(new Error(privateText));
      expectRedacted(summarizeError(error, controller.signal));
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
    expect(summarizeError(error, controller.signal)).not.toContain("abortReason=");
    controller.abort(reason);
    const summary = summarizeError(error, controller.signal);
    expect(summary).toContain(`abortReason=${expected}`);
    expect(summary).not.toContain("private");
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
});
